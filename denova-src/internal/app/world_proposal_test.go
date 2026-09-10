package app

import (
	"errors"
	"testing"
)

func proposalErrCode(t *testing.T, err error) string {
	t.Helper()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	var pe *ProposalError
	if !errors.As(err, &pe) {
		t.Fatalf("expected *ProposalError, got %T: %v", err, err)
	}
	return pe.Code
}

func TestParseModelStructureProposal_Valid(t *testing.T) {
	content := `{"setting":{"sourceRefIds":["s0"],"confidence":"medium","tone":"黑暗","rules":[{"sourceRefIds":["s0"],"confidence":"low","text":"魔法有代价"}]},"characters":[{"sourceRefIds":["s0"],"confidence":"high","displayName":"艾兰妮","role":"major"}],"locations":[],"factions":[]}`
	model, err := parseModelStructureProposal(content)
	if err != nil {
		t.Fatalf("parse valid: %v", err)
	}
	if model.Setting == nil || len(model.Setting.Rules) != 1 || model.Setting.Rules[0].Text != "魔法有代价" {
		t.Fatalf("unexpected parse result: %+v", model)
	}
	if len(model.Characters) != 1 || model.Characters[0].DisplayName != "艾兰妮" {
		t.Fatalf("unexpected characters: %+v", model.Characters)
	}
}

func TestParseModelStructureProposal_Rejects(t *testing.T) {
	cases := map[string]string{
		"empty":        "",
		"markdown":     "```json\n{\"characters\":[],\"locations\":[],\"factions\":[]}\n```",
		"unknown":      `{"characters":[],"locations":[],"factions":[],"timeline":[]}`,
		"timeline":     `{"characters":[],"locations":[],"factions":[],"timeline":[{"title":"x"}]}`,
		"multi-json":   `{"characters":[],"locations":[],"factions":[]}{"characters":[]}`,
		"trailing":     `{"characters":[],"locations":[],"factions":[]} trailing`,
		"extra-field":  `{"characters":[],"locations":[],"factions":[],"worldName":"x"}`,
		"not-json":     `hello world`,
	}
	for name, content := range cases {
		if _, err := parseModelStructureProposal(content); err == nil {
			t.Errorf("case %s: expected error, got nil", name)
		} else if proposalErrCode(t, err) != "invalid_model_output" {
			t.Errorf("case %s: code = %s, want invalid_model_output", name, proposalErrCode(t, err))
		}
	}
}

func TestEnhanceStructureProposal_StampsIDs(t *testing.T) {
	refs := []ProposalSourceRef{{ID: "s0", Kind: "master_field", MasterItemID: "m1", Label: "A"}, {ID: "u0", Kind: "user_snippet", SnippetID: "snip", Label: "B"}}
	byShortID := map[string]ProposalSourceRef{"s0": refs[0], "u0": refs[1]}
	model := &modelStructureProposal{
		Characters: []modelProposedCharacter{{modelProposalBase: modelProposalBase{SourceRefIDs: []string{"s0"}, Confidence: "high"}, DisplayName: "角色", Role: "protagonist"}},
	}
	out, err := enhanceStructureProposal(model, refs, byShortID)
	if err != nil {
		t.Fatalf("enhance: %v", err)
	}
	if out.SchemaVersion != 1 || out.GeneratedAt == "" {
		t.Fatalf("missing server fields: %+v", out)
	}
	if len(out.Characters) != 1 || out.Characters[0].ProposalItemID == "" {
		t.Fatalf("missing proposalItemId: %+v", out.Characters)
	}
	if len(out.SourceRefs) != 2 {
		t.Fatalf("sourceRefs = %d, want 2", len(out.SourceRefs))
	}
}

func TestEnhanceStructureProposal_Rejects(t *testing.T) {
	refs := []ProposalSourceRef{{ID: "s0", Kind: "master_field", Label: "A"}}
	byShortID := map[string]ProposalSourceRef{"s0": refs[0]}
	cases := map[string]func() *modelStructureProposal{
		"unknown-ref": func() *modelStructureProposal {
			return &modelStructureProposal{Characters: []modelProposedCharacter{{modelProposalBase: modelProposalBase{SourceRefIDs: []string{"zz"}, Confidence: "high"}, DisplayName: "x"}}}
		},
		"empty-refs": func() *modelStructureProposal {
			return &modelStructureProposal{Characters: []modelProposedCharacter{{modelProposalBase: modelProposalBase{Confidence: "high"}, DisplayName: "x"}}}
		},
		"bad-confidence": func() *modelStructureProposal {
			return &modelStructureProposal{Characters: []modelProposedCharacter{{modelProposalBase: modelProposalBase{SourceRefIDs: []string{"s0"}, Confidence: "sure"}, DisplayName: "x"}}}
		},
		"bad-role": func() *modelStructureProposal {
			return &modelStructureProposal{Characters: []modelProposedCharacter{{modelProposalBase: modelProposalBase{SourceRefIDs: []string{"s0"}, Confidence: "high"}, DisplayName: "x", Role: "boss"}}}
		},
		"missing-name": func() *modelStructureProposal {
			return &modelStructureProposal{Characters: []modelProposedCharacter{{modelProposalBase: modelProposalBase{SourceRefIDs: []string{"s0"}, Confidence: "high"}}}}
		},
		"empty-rule": func() *modelStructureProposal {
			return &modelStructureProposal{Setting: &modelProposedSetting{modelProposalBase: modelProposalBase{SourceRefIDs: []string{"s0"}, Confidence: "high"}, Rules: []modelProposedRule{{modelProposalBase: modelProposalBase{SourceRefIDs: []string{"s0"}, Confidence: "high"}, Text: "  "}}}}
		},
	}
	for name, makeModel := range cases {
		if _, err := enhanceStructureProposal(makeModel(), refs, byShortID); err == nil {
			t.Errorf("case %s: expected error", name)
		} else if proposalErrCode(t, err) != "invalid_model_output" {
			t.Errorf("case %s: code = %s", name, proposalErrCode(t, err))
		}
	}
}

func TestFieldPathAllowed(t *testing.T) {
	ok := map[string]bool{
		"character_template|lorebook.name":                           false,
		"character_template|character.name":                          true,
		"character_template|character.personality":                   true,
		"character_template|character.system_prompt":                 false,
		"lorebook_template|lorebook.name":                            true,
		"lorebook_template|lorebook.entries/e1/content":              true,
		"lorebook_template|lorebook.entries/e1/secondary_keys":       true,
		"lorebook_template|lorebook.entries/e1/unknown":              false,
		"lorebook_template|lorebook.entries/e1":                      false,
	}
	for key, want := range ok {
		var kind, path string
		for i, part := range split2(key, "|") {
			if i == 0 {
				kind = part
			} else {
				path = part
			}
		}
		if got := fieldPathAllowed(kind, path); got != want {
			t.Errorf("fieldPathAllowed(%q,%q) = %v, want %v", kind, path, got, want)
		}
	}
}

func split2(s, sep string) []string {
	for i := 0; i < len(s); i++ {
		if string(s[i]) == sep {
			return []string{s[:i], s[i+1:]}
		}
	}
	return []string{s}
}

func TestValidateProposalRequest(t *testing.T) {
	manyAssets := make([]WorldProposalSource, proposalMaxAssets+1)
	for i := range manyAssets {
		manyAssets[i] = WorldProposalSource{MasterItemID: "m", FieldPaths: []string{"character.name"}}
	}
	if err := validateProposalRequest(WorldStructureAnalysisRequest{Sources: manyAssets}); proposalErrCode(t, err) != "input_too_large" {
		t.Fatalf("many assets: %v", err)
	}
	empty := []WorldProposalSource{{MasterItemID: "  "}}
	if err := validateProposalRequest(WorldStructureAnalysisRequest{Sources: empty}); proposalErrCode(t, err) != "invalid_request" {
		t.Fatalf("empty id: %v", err)
	}
	manySnippets := make([]WorldProposalSnippet, proposalMaxSnippets+1)
	if err := validateProposalRequest(WorldStructureAnalysisRequest{Snippets: manySnippets}); proposalErrCode(t, err) != "input_too_large" {
		t.Fatalf("many snippets: %v", err)
	}
}

func TestMapProposalGatewayError(t *testing.T) {
	cases := map[string]struct{ code string; status int }{
		"not_found":           {"model_not_found", 404},
		"not_configured":      {"not_configured", 400},
		"unauthorized":        {"unauthorized", 401},
		"rate_limited":        {"rate_limited", 429},
		"timeout":             {"timeout", 504},
		"provider_unavailable": {"provider_unavailable", 502},
		"upstream_error":      {"provider_unavailable", 502},
		"empty_response":      {"invalid_model_output", 422},
		"invalid_request":     {"invalid_request", 400},
	}
	for in, want := range cases {
		err := mapProposalGatewayError(&ModelGatewayError{Code: in, Message: "x"})
		pe, ok := err.(*ProposalError)
		if !ok {
			t.Fatalf("%s: not proposal error: %v", in, err)
		}
		if pe.Code != want.code || pe.HTTPStatus != want.status {
			t.Errorf("%s: got (%s,%d), want (%s,%d)", in, pe.Code, pe.HTTPStatus, want.code, want.status)
		}
	}
}

func TestSemanticMapping(t *testing.T) {
	if got := semanticOfAsset("lorebook"); got != "other" {
		t.Errorf("lorebook -> %s, want other", got)
	}
	if got := semanticOfAsset("character"); got != "character" {
		t.Errorf("character -> %s", got)
	}
	if got := scopeOfSemantic("other"); got != "world" {
		t.Errorf("other scope -> %s, want world", got)
	}
	if got := scopeOfSemantic("character"); got != "entity" {
		t.Errorf("character scope -> %s, want entity", got)
	}
}
