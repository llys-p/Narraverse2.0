package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"denova/internal/book"
	"denova/internal/workspacechange"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
)

const bookOverviewToolPath = "setting/book-overview.md"
const bookManagementMaxBytes = 1024 * 1024

type writeBookOverviewInput struct {
	Content      *string `json:"content" jsonschema:"required,description=完整书籍总览 Markdown；先读取旧文，仅按用户要求修改"`
	BaseRevision string  `json:"base_revision" jsonschema:"required,description=read_book_overview 返回的 revision；总览不存在时为 missing，不可自行猜测"`
}

type writeLoreRelationsInput struct {
	Message string                    `json:"message" jsonschema:"description=本次关系变更说明"`
	Items   []book.LoreRelationUpdate `json:"items" jsonschema:"description=1–16 个源条目的关系替换，每项含 id/base_revision/relations；relations 为完整出向关系数组，清空用 []"`
}

// Management tools use only the captured book workspace. The overview shares
// the editor's durable CAS service; relations use the existing lore transaction.
func newConfigManagerBookTools(workspace string) ([]tool.BaseTool, error) {
	readOverview, err := utils.InferTool("read_book_overview", "读取当前书籍总览 Markdown 与 revision。缺文件返回 exists=false/revision=missing；不读取全部小说。", func(ctx context.Context, _ struct{}) (string, error) {
		if strings.TrimSpace(workspace) == "" {
			return "", fmt.Errorf("当前没有打开书籍，无法读取总览")
		}
		service, err := workspacechange.ForWorkspace(workspace)
		if err != nil {
			return "", err
		}
		content, revision, err := service.ReadFile(bookOverviewToolPath)
		exists := true
		if err != nil {
			var changeErr *workspacechange.Error
			if !errors.As(err, &changeErr) || changeErr.Code != workspacechange.ErrorCodeNotFound {
				return "", err
			}
			exists, content, revision = false, "", "missing"
		}
		if len(content) > bookManagementMaxBytes {
			return "", fmt.Errorf("书籍总览超过 1 MiB 读取上限，请先在编辑器缩减内容")
		}
		data, err := json.Marshal(struct {
			Path     string `json:"path"`
			Exists   bool   `json:"exists"`
			Content  string `json:"content"`
			Revision string `json:"revision"`
		}{bookOverviewToolPath, exists, content, revision})
		return string(data), err
	})
	if err != nil {
		return nil, err
	}
	writeOverview, err := utils.InferTool("write_book_overview", "按读取到的 base_revision 保存当前书籍总览；旧版本冲突不覆盖。只在用户要求保存时调用。", func(ctx context.Context, input writeBookOverviewInput) (string, error) {
		if strings.TrimSpace(workspace) == "" {
			return "", fmt.Errorf("当前没有打开书籍，无法保存总览")
		}
		if input.Content == nil {
			return "", fmt.Errorf("必须明确提供总览 content，清空需传空字符串")
		}
		if len(*input.Content) > bookManagementMaxBytes {
			return "", fmt.Errorf("书籍总览超过 1 MiB 保存上限")
		}
		service, err := workspacechange.ForWorkspace(workspace)
		if err != nil {
			return "", err
		}
		change, err := service.ReplaceFile(ctx, workspacechange.ReplaceFileRequest{
			Path: bookOverviewToolPath, Content: *input.Content, BaseRevision: input.BaseRevision, Metadata: workspaceChangeMetadata(ctx),
		})
		if err != nil {
			return "", err
		}
		return marshalWorkspaceChangeToolReceipt(workspace, change)
	})
	if err != nil {
		return nil, err
	}
	readRelations, err := utils.InferTool("read_lore_relations", "按本书条目 ids 读取明确关系、入向关系、名称及 base_revision；正文推导线不作为确认关系。每次最多 16 个源条目。", func(ctx context.Context, input idListInput) (string, error) {
		if strings.TrimSpace(workspace) == "" {
			return "", fmt.Errorf("当前没有打开书籍，无法读取关系")
		}
		if len(input.IDs) == 0 || len(input.IDs) > 16 {
			return "", fmt.Errorf("须提供 1–16 个资料条目 ID")
		}
		items, err := book.NewLoreStore(workspace).ListAll()
		if err != nil {
			return "", err
		}
		byID := map[string]book.LoreItem{}
		for _, item := range items {
			byID[item.ID] = item
		}
		type incoming struct {
			SourceID   string `json:"source_id"`
			SourceName string `json:"source_name"`
			Label      string `json:"label"`
			Note       string `json:"note,omitempty"`
		}
		type source struct {
			ID           string              `json:"id"`
			Name         string              `json:"name"`
			BaseRevision string              `json:"base_revision"`
			Relations    []book.LoreRelation `json:"relations"`
			Incoming     []incoming          `json:"incoming"`
		}
		out := make([]source, 0, len(input.IDs))
		for _, id := range input.IDs {
			item, ok := byID[strings.TrimSpace(id)]
			if !ok {
				return "", fmt.Errorf("资料条目不存在: %s", id)
			}
			row := source{ID: item.ID, Name: item.Name, BaseRevision: item.UpdatedAt, Relations: append([]book.LoreRelation{}, item.Relations...), Incoming: []incoming{}}
			for _, other := range items {
				for _, relation := range other.Relations {
					if relation.TargetID == item.ID {
						row.Incoming = append(row.Incoming, incoming{other.ID, other.Name, relation.Label, relation.Note})
					}
				}
			}
			out = append(out, row)
		}
		data, err := json.Marshal(out)
		if len(data) > bookManagementMaxBytes {
			return "", fmt.Errorf("关系结果超过 1 MiB 上限，请减少条目数量")
		}
		return string(data), err
	})
	if err != nil {
		return nil, err
	}
	writeRelations, err := utils.InferTool("write_lore_relations", "替换本书条目间的明确关系，目标必须是本书另一条已存在资料。先 read_lore_relations 获取版本和全部原关系；保留未要求变更的关系，清空用 []。整批校验后一次保存，不改条目正文。", func(ctx context.Context, input writeLoreRelationsInput) (string, error) {
		if strings.TrimSpace(workspace) == "" {
			return "", fmt.Errorf("当前没有打开书籍，无法保存关系")
		}
		items, err := book.NewLoreStore(workspace).WriteRelations(input.Items)
		if err != nil {
			return "", err
		}
		return formatWriteLoreItemsResult(book.LoreApplyResult{Message: input.Message, Updated: items}), nil
	})
	if err != nil {
		return nil, err
	}
	return []tool.BaseTool{readOverview, writeOverview, readRelations, writeRelations}, nil
}
