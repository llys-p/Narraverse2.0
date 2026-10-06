package app

import (
	"context"
	"errors"
	"log"
	"strings"

	"denova/internal/bookideation"
)

// BookIdeation returns the ideation draft service for 新建书籍. It reuses the
// shared model gateway and the existing book/lore persistence, and it keeps the
// ideation chain tool-free: the only model seam is the one-shot gateway call, so
// ideation cannot reach a book-writing tool even if a future agent gains one.
func (a *App) BookIdeation() (*bookideation.Service, error) {
	if a == nil {
		return nil, errors.New("应用运行时不存在")
	}
	dataDir := strings.TrimSpace(a.novaDir())
	if dataDir == "" {
		return nil, errors.New("构思草稿需要 Denova 数据目录")
	}
	store, err := bookideation.NewStore(dataDir)
	if err != nil {
		return nil, err
	}
	layered, err := a.Settings()
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(layered.Paths.DenovaDir) == "" {
		return nil, errors.New("书籍创建需要 Denova 数据目录配置")
	}
	return bookideation.NewService(store, ideationModel{app: a}, ideationWorkspaces{app: a}, layered.Paths.DenovaDir), nil
}

// ideationModel adapts the shared one-shot gateway to the ideation seam. It uses
// the writing module's resolved profile and never forwards a credential.
type ideationModel struct {
	app *App
}

func (m ideationModel) Generate(ctx context.Context, request bookideation.ModelRequest) (bookideation.ModelReply, error) {
	messages := make([]ModelGatewayMessage, 0, len(request.Messages)+1)
	if strings.TrimSpace(request.SystemPrompt) != "" {
		messages = append(messages, ModelGatewayMessage{Role: "system", Content: request.SystemPrompt})
	}
	for _, message := range request.Messages {
		messages = append(messages, ModelGatewayMessage{Role: message.Role, Content: message.Content})
	}
	result, err := m.app.GenerateModel(ctx, ModelGatewayChatRequest{
		Module:    ModelModuleWriting,
		Messages:  messages,
		MaxTokens: request.MaxTokens,
	})
	if err != nil {
		log.Printf("[book-ideation] model call failed err=%v", err)
		return bookideation.ModelReply{}, err
	}
	return bookideation.ModelReply{Content: result.Content, Model: result.Model, Profile: result.ProfileID}, nil
}

// ideationWorkspaces creates the target book without switching the running
// workspace; the client switches only after the whole commit succeeded.
type ideationWorkspaces struct {
	app *App
}

func (w ideationWorkspaces) CreateBookDetached(ctx context.Context, parentDir, title, author, description string) (string, error) {
	workspace, _, err := w.app.CreateBookDetached(ctx, parentDir, title, author, description)
	if err != nil {
		return "", err
	}
	log.Printf("[book-ideation] detached book created workspace=%s", workspace)
	return workspace, nil
}
