package app

import (
	"context"
	"crypto/rand"

	"denova/internal/agent"
	"denova/internal/worldcontext"
)

// writingRunSaltSize 与 worldcontext 内部 runSalt 长度保持一致（32 字节）。
const writingRunSaltSize = 32

// BuildWritingEphemeralWorld 在“不创建/不占用 runContext、不写 World、不创建 handle”的前提下，
// 只读装配写作的临时世界背景输入：已保存 World + Ref → Snapshot → ProjectionBody →
// 最终 ModelView bytes（与 runContext.ModelViewBytes 走同一物化/稳定序列化/96KiB 门禁路径），
// 再交给 agent.NewEphemeralWorldContextInput 产出与真实模型输入同字节的临时抬头。
//
// 它用于 context-analysis 展示（A3 同字节装配能力）；真正的写作运行仍使用绑定 runContext 的 bytes。
func (s *WorldContextService) BuildWritingEphemeralWorld(ctx context.Context, ref worldcontext.Ref) (agent.EphemeralWorldContextInput, error) {
	snap, err := s.loadSnapshot(ctx, worldcontext.ConsumerWriting, ref)
	if err != nil {
		return agent.EphemeralWorldContextInput{}, err
	}
	body, err := worldcontext.ProjectModelBody(snap)
	if err != nil {
		return agent.EphemeralWorldContextInput{}, err
	}
	salt := make([]byte, writingRunSaltSize)
	if _, err := rand.Read(salt); err != nil {
		return agent.EphemeralWorldContextInput{}, err
	}
	_, modelViewBytes, err := worldcontext.MaterializeModelViewBytes(body, worldcontext.ConsumerWriting, salt)
	if err != nil {
		return agent.EphemeralWorldContextInput{}, err
	}
	return agent.NewEphemeralWorldContextInput(modelViewBytes), nil
}
