package world

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// TimelineCategory 是时间线在磁盘上的分类值。
// canon 只作为旧数据兼容值保留；新建和显式编辑只允许三种新值。
type TimelineCategory string

const (
	TimelineBackground TimelineCategory = "background"
	TimelineHistorical TimelineCategory = "historical"
	TimelinePlanned    TimelineCategory = "planned"
	TimelineCanon      TimelineCategory = "canon" // legacy read-only value
)

type timelineCategoryRawState struct {
	initialized bool
	raw         json.RawMessage
}

func (e *TimelineEntry) UnmarshalJSON(data []byte) error {
	var wire struct {
		ID          string          `json:"id"`
		Order       int             `json:"order"`
		EraLabel    string          `json:"eraLabel,omitempty"`
		Title       string          `json:"title"`
		Description string          `json:"description,omitempty"`
		Category    json.RawMessage `json:"category"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}

	e.ID = wire.ID
	e.Order = wire.Order
	e.EraLabel = wire.EraLabel
	e.Title = wire.Title
	e.Description = wire.Description
	e.categoryState = timelineCategoryRawState{
		initialized: true,
		raw:         append(json.RawMessage(nil), wire.Category...),
	}
	if len(wire.Category) == 0 || bytes.Equal(bytes.TrimSpace(wire.Category), []byte("null")) {
		e.Category = ""
		return nil
	}
	var value string
	if err := json.Unmarshal(wire.Category, &value); err != nil {
		return fmt.Errorf("timeline category must be a string or null: %w", err)
	}
	e.Category = TimelineCategory(value)
	return nil
}

func (e TimelineEntry) MarshalJSON() ([]byte, error) {
	rawCategory := e.categoryJSON()
	wire := struct {
		ID          string          `json:"id"`
		Order       int             `json:"order"`
		EraLabel    string          `json:"eraLabel,omitempty"`
		Title       string          `json:"title"`
		Description string          `json:"description,omitempty"`
		Category    json.RawMessage `json:"category,omitempty"`
	}{
		ID:          e.ID,
		Order:       e.Order,
		EraLabel:    e.EraLabel,
		Title:       e.Title,
		Description: e.Description,
		Category:    rawCategory,
	}
	return json.Marshal(wire)
}

func (e TimelineEntry) categoryJSON() json.RawMessage {
	if e.categoryState.initialized {
		if len(e.categoryState.raw) == 0 || bytes.Equal(bytes.TrimSpace(e.categoryState.raw), []byte("null")) {
			if e.Category == "" {
				return append(json.RawMessage(nil), e.categoryState.raw...)
			}
			return marshalTimelineCategory(e.Category)
		}
		var original string
		if json.Unmarshal(e.categoryState.raw, &original) == nil && TimelineCategory(original) == e.Category {
			return append(json.RawMessage(nil), e.categoryState.raw...)
		}
		return marshalTimelineCategory(e.Category)
	}
	if e.Category == "" {
		return marshalTimelineCategory(TimelineBackground)
	}
	return marshalTimelineCategory(e.Category)
}

func marshalTimelineCategory(category TimelineCategory) json.RawMessage {
	value, _ := json.Marshal(string(category))
	return value
}

func (e *TimelineEntry) setTimelineCategory(category TimelineCategory) {
	e.Category = category
	e.categoryState = timelineCategoryRawState{}
}

// NormalizeTimelineCategoryForDisplay maps old or malformed-but-readable values
// to the three-value UI/Model vocabulary without changing the stored value.
func NormalizeTimelineCategoryForDisplay(category TimelineCategory) TimelineCategory {
	switch category {
	case TimelineHistorical:
		return TimelineHistorical
	case TimelinePlanned:
		return TimelinePlanned
	case TimelineBackground:
		return TimelineBackground
	case TimelineCanon:
		return TimelineHistorical
	default:
		return TimelineBackground
	}
}

func isWritableTimelineCategory(category TimelineCategory) bool {
	switch category {
	case TimelineBackground, TimelineHistorical, TimelinePlanned:
		return true
	default:
		return false
	}
}

func timelineCategoryWireEqual(a, b TimelineEntry) bool {
	return bytes.Equal(a.categoryJSON(), b.categoryJSON())
}
