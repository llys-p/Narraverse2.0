package worldcontext

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"denova/internal/world"
)

// marshalStable 产出确定性 JSON：结构体按字段声明序、map key 按字典序、无多余空白。
// 领域内所有“同输入必同字节”的需求（fingerprint、字节预算、缓存键）都走它。
func marshalStable(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return b, nil
}

// ProjectForUI 从 Snapshot 生成控制台 UIView（v2.7 §4.9）：
// 全量保留内部 id/omissions，附 sourceTable、revisionLabel；不输出 Master 正文/头像/绝对路径。
func ProjectForUI(snap *Snapshot) *UIView {
	table := map[string]SourceTableEntry{}
	table["identity"] = SourceTableEntry{Kind: SourceIdentity}
	if snap.Setting != nil {
		table["setting"] = SourceTableEntry{Kind: SourceSetting}
	}
	for _, c := range snap.Characters {
		table["character:"+c.ID] = SourceTableEntry{Kind: SourceCharacter, EntityID: c.ID}
	}
	for _, l := range snap.Locations {
		table["location:"+l.ID] = SourceTableEntry{Kind: SourceLocation, EntityID: l.ID}
	}
	for _, f := range snap.Factions {
		table["faction:"+f.ID] = SourceTableEntry{Kind: SourceFaction, EntityID: f.ID}
	}
	for _, t := range snap.Timeline {
		table["timeline:"+t.ID] = SourceTableEntry{Kind: SourceTimeline, EntityID: t.ID}
	}
	for _, m := range snap.Materials {
		table["material:"+m.BindingID] = SourceTableEntry{
			Kind: SourceMaterial, BindingID: m.BindingID, MasterItemID: m.MasterItemID,
		}
	}
	return &UIView{
		Snapshot:       snap,
		SourceTable:    table,
		RevisionLabel:  shortRevision(snap.WorldRevision),
		IsDraftPreview: false,
	}
}

func shortRevision(rev string) string {
	const n = 12
	if len(rev) <= n {
		return rev
	}
	return rev[:n]
}

// ProjectModelBody 从 Snapshot 生成 source-neutral ProjectionBody（v2.7 §4.1/§4.10）。
// 实体段去除一切内部 id，跨实体引用解析为展示名；来源以内部稳定键暂存，物化时才换 sourceRef。
func ProjectModelBody(snap *Snapshot) (*ProjectionBody, error) {
	charName := map[string]string{}
	for _, c := range snap.Characters {
		charName[c.ID] = c.DisplayName
	}
	locName := map[string]string{}
	for _, l := range snap.Locations {
		locName[l.ID] = l.Name
	}
	facName := map[string]string{}
	for _, f := range snap.Factions {
		facName[f.ID] = f.Name
	}

	body := &ProjectionBody{
		SchemaVersion: SchemaVersion,
		Identity:      snap.Identity,
		Setting:       snap.Setting,
		Characters:    []ModelCharacter{},
		Locations:     []ModelLocation{},
		Factions:      []ModelFaction{},
		Timeline:      []ModelTimelineEntry{},
		Materials:     []ModelMaterial{},
		Sources:       []BodySource{},
	}

	body.Sources = append(body.Sources, BodySource{RefKind: SourceIdentity, RefValue: "identity", Label: snap.Identity.Name})
	if snap.Setting != nil {
		body.Sources = append(body.Sources, BodySource{RefKind: SourceSetting, RefValue: "setting", Label: "世界设定"})
	}

	for _, c := range snap.Characters {
		mc := ModelCharacter{
			DisplayName:   c.DisplayName,
			Role:          c.Role,
			WorldNote:     c.WorldNote,
			FactionLabel:  facName[c.FactionID],
			LocationLabel: locName[c.LocationID],
			Relationships: []ModelRelationship{},
		}
		for _, rel := range c.Relationships {
			mc.Relationships = append(mc.Relationships, ModelRelationship{
				TargetLabel: charName[rel.TargetCharacterID], Label: rel.Label,
			})
		}
		body.Characters = append(body.Characters, mc)
		body.Sources = append(body.Sources, BodySource{RefKind: SourceCharacter, RefValue: c.ID, Label: c.DisplayName})
	}
	for _, l := range snap.Locations {
		body.Locations = append(body.Locations, ModelLocation{
			Name: l.Name, Description: l.Description, Tags: orEmptyTags(l.Tags),
		})
		body.Sources = append(body.Sources, BodySource{RefKind: SourceLocation, RefValue: l.ID, Label: l.Name})
	}
	for _, f := range snap.Factions {
		mf := ModelFaction{
			Name: f.Name, Description: f.Description, Influence: f.Influence, Stability: f.Stability,
			HeadquartersLabel: locName[f.HeadquartersLocationID],
		}
		body.Factions = append(body.Factions, mf)
		body.Sources = append(body.Sources, BodySource{RefKind: SourceFaction, RefValue: f.ID, Label: f.Name})
	}
	for _, t := range snap.Timeline {
		body.Timeline = append(body.Timeline, ModelTimelineEntry{
			Order: t.Order, EraLabel: t.EraLabel, Title: t.Title, Description: t.Description, Category: t.Category,
		})
		body.Sources = append(body.Sources, BodySource{RefKind: SourceTimeline, RefValue: t.ID, Label: t.Title})
	}
	for _, m := range snap.Materials {
		body.Materials = append(body.Materials, ModelMaterial{
			Name: m.Name, Tags: orEmptyTags(m.Tags), SemanticTypeLabel: semanticTypeLabel(m.SemanticType),
		})
		body.Sources = append(body.Sources, BodySource{RefKind: SourceMaterial, RefValue: m.BindingID, Label: m.Name})
	}

	if len(body.Sources) > 60 {
		return nil, domainError(ErrProjectionFailed, "sources", "来源数量超过 60 上限")
	}
	return body, nil
}

// semanticTypeLabel 返回模型可见的语义类型展示名；领域层语言中立，直接使用冻结枚举值。
func semanticTypeLabel(t world.SemanticType) string {
	switch t {
	case world.SemanticCharacter, world.SemanticWorld, world.SemanticLocation, world.SemanticFaction,
		world.SemanticRule, world.SemanticItem, world.SemanticOther:
		return string(t)
	default:
		return string(world.SemanticOther)
	}
}

// MaterializeModelView 用每 run 独占的 runSalt 把 source-neutral Body 物化为最终 ModelView。
// runSalt 必须是 32 字节随机值（由后续 runContext 层生成；P0 只接收，不自行产生随机性）。
func MaterializeModelView(body *ProjectionBody, consumer Consumer, runSalt []byte) (*ModelView, error) {
	if body == nil {
		return nil, domainError(ErrProjectionFailed, "body", "投影体为空")
	}
	if consumer != ConsumerWriting && consumer != ConsumerGame {
		return nil, domainError(ErrConsumerNotTrusted, "consumer", "当前阶段不允许该模式物化模型视图")
	}
	if len(runSalt) != 32 {
		return nil, domainError(ErrProjectionFailed, "runSalt", "runSalt 必须为 32 字节")
	}

	mv := &ModelView{
		SchemaVersion: body.SchemaVersion,
		Identity:      body.Identity,
		Setting:       body.Setting,
		Characters:    append([]ModelCharacter{}, body.Characters...),
		Locations:     append([]ModelLocation{}, body.Locations...),
		Factions:      append([]ModelFaction{}, body.Factions...),
		Timeline:      append([]ModelTimelineEntry{}, body.Timeline...),
		Materials:     append([]ModelMaterial{}, body.Materials...),
		Sources:       []ModelSource{},
	}
	seenRef := map[string]struct{}{}
	for _, s := range body.Sources {
		ref, err := sourceRef(runSalt, consumer, s.RefKind, s.RefValue)
		if err != nil {
			return nil, err
		}
		if _, dup := seenRef[ref]; dup {
			return nil, domainError(ErrProjectionFailed, "sources", "同一 run 内 sourceRef 必须唯一")
		}
		seenRef[ref] = struct{}{}
		mv.Sources = append(mv.Sources, ModelSource{Ref: ref, Kind: s.RefKind, Label: s.Label})
	}
	return mv, nil
}

// sourceRef = base64url( HMAC-SHA256(runSalt, consumer|refKind|refValue)[0:16] )（v2.7 §4.4）。
// 它在同一 run 内稳定、跨 run 不可复现，且不是 masterItemId 的可逆编码。
func sourceRef(runSalt []byte, consumer Consumer, kind SourceKind, refValue string) (string, error) {
	mac := hmac.New(sha256.New, runSalt)
	if _, err := fmt.Fprintf(mac, "%s|%s|%s", consumer, kind, refValue); err != nil {
		return "", domainError(ErrProjectionFailed, "sourceRef", "sourceRef 计算失败")
	}
	sum := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(sum[:16]), nil
}
