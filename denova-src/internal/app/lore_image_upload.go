package app

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"denova/internal/book"
	"github.com/google/uuid"
)

const LoreUploadFileMaxBytes = 10 << 20
const LoreUploadBatchMaxBytes = 32 << 20

var ErrLoreUploadWorkspace = errors.New("lore upload workspace changed")
var ErrLoreUploadInvalid = errors.New("unsupported or oversized lore image upload")

type LoreImageUpload struct {
	Filename string
	Data     []byte
}

// UploadLoreImages pins the requested workspace for the entire operation and
// validates the whole batch before writing. No model configuration is needed.
func (a *App) UploadLoreImages(workspace, id string, uploads []LoreImageUpload) (book.LoreItem, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if workspace == "" || workspace != a.workspace || a.bookService == nil {
		return book.LoreItem{}, ErrLoreUploadWorkspace
	}
	if len(uploads) == 0 || len(uploads) > book.MaxLoreItemImages {
		return book.LoreItem{}, ErrLoreUploadInvalid
	}
	store := book.NewLoreStore(workspace)
	item, err := store.ReadAny(id)
	if err != nil {
		return book.LoreItem{}, err
	}
	if len(item.Images)+len(uploads) > book.MaxLoreItemImages {
		return book.LoreItem{}, book.ErrLoreImageLimit
	}
	images := make([]book.LoreItemImage, 0, len(uploads))
	total := 0
	for _, upload := range uploads {
		total += len(upload.Data)
		if len(upload.Data) == 0 || len(upload.Data) > LoreUploadFileMaxBytes || total > LoreUploadBatchMaxBytes {
			return book.LoreItem{}, ErrLoreUploadInvalid
		}
		mimeType := http.DetectContentType(upload.Data)
		ext := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}[mimeType]
		if ext == "" {
			return book.LoreItem{}, ErrLoreUploadInvalid
		}
		// File names from the browser are labels only, never filesystem paths.
		name := filepath.Base(strings.ReplaceAll(upload.Filename, "\\", "/"))
		images = append(images, book.LoreItemImage{
			Schema: "lore_item_image.v1", ImagePath: "assets/lore/uploads/" + uuid.NewString() + "." + ext,
			AltText: name, Provider: "upload", MIMEType: mimeType, OutputFormat: ext,
			SizeBytes: len(upload.Data), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		})
	}
	for i, img := range images {
		if err := a.bookService.WriteBinaryFile(img.ImagePath, uploads[i].Data); err != nil {
			return book.LoreItem{}, fmt.Errorf("save lore image: %w", err)
		}
	}
	updated, err := store.AppendImages(item.ID, images)
	if err != nil {
		return book.LoreItem{}, err
	}
	log.Printf("[lore-image] uploaded item_id=%s count=%d bytes=%d", item.ID, len(images), total)
	return updated, nil
}

func (a *App) RemoveLoreImageAttachment(workspace, id, imagePath string) (book.LoreItem, error) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if workspace == "" || workspace != a.workspace || a.bookService == nil {
		return book.LoreItem{}, ErrLoreUploadWorkspace
	}
	item, err := book.NewLoreStore(workspace).RemoveImageAttachment(id, imagePath)
	if err == nil {
		log.Printf("[lore-image] detached item_id=%s", item.ID)
	}
	return item, err
}
