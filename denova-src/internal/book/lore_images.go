package book

import (
	"errors"
	"time"
)

// MaxLoreItemImages bounds manual attachments per entry; the AI image is separate.
const MaxLoreItemImages = 20

var ErrLoreImageLimit = errors.New("lore image attachment limit exceeded")
var ErrLoreImageMissing = errors.New("lore image attachment not found")

// AppendImages merges with the latest stored item under its mutation lock, so
// uploads never overwrite concurrently edited text or other images.
func (s *LoreStore) AppendImages(id string, images []LoreItemImage) (LoreItem, error) {
	return s.updateImageAttachments(id, func(current []LoreItemImage) ([]LoreItemImage, error) {
		if len(current)+len(images) > MaxLoreItemImages {
			return nil, ErrLoreImageLimit
		}
		next := append([]LoreItemImage(nil), current...)
		for _, img := range images {
			normalized := normalizeLoreItemImage(&img)
			if normalized == nil {
				return nil, ErrLoreImageMissing
			}
			next = append(next, *normalized)
		}
		return next, nil
	})
}

// RemoveImageAttachment only detaches one uploaded image; stored assets and
// the existing AI image remain untouched and can still be recovered.
func (s *LoreStore) RemoveImageAttachment(id, imagePath string) (LoreItem, error) {
	return s.updateImageAttachments(id, func(current []LoreItemImage) ([]LoreItemImage, error) {
		for i, img := range current {
			if img.ImagePath == imagePath {
				return append(append([]LoreItemImage(nil), current[:i]...), current[i+1:]...), nil
			}
		}
		return nil, ErrLoreImageMissing
	})
}

func (s *LoreStore) updateImageAttachments(id string, change func([]LoreItemImage) ([]LoreItemImage, error)) (LoreItem, error) {
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	collection, err := s.loadOrCreate()
	if err != nil {
		return LoreItem{}, err
	}
	for i := range collection.Items {
		if collection.Items[i].ID != normalizeLoreID(id) {
			continue
		}
		images, err := change(collection.Items[i].Images)
		if err != nil {
			return LoreItem{}, err
		}
		collection.Items[i].Images = images
		collection.Items[i].UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		if err := s.save(collection); err != nil {
			return LoreItem{}, err
		}
		return collection.Items[i], nil
	}
	return LoreItem{}, ErrLoreImageMissing
}
