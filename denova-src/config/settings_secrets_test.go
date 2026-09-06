package config

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRedactLayeredSettingsSecrets(t *testing.T) {
	layered := LayeredSettings{
		Default: Settings{
			OpenAIAPIKey: "legacy-model-secret",
			ModelProfiles: []ModelProfileSettings{{
				ID:           "default",
				OpenAIAPIKey: "default-model-secret",
			}},
			ImageAPIKey: "legacy-image-secret",
			ImageAPIProfiles: []ImageAPIProfileSettings{{
				ID:           "cover",
				OpenAIAPIKey: "cover-image-secret",
			}},
		},
	}

	redacted := RedactLayeredSettingsSecrets(layered)
	for _, settings := range []Settings{
		redacted.Default,
		redacted.Global,
		redacted.User,
		redacted.Workspace,
		redacted.Effective,
	} {
		if settings.OpenAIAPIKey != "" || settings.ImageAPIKey != "" {
			t.Fatalf("legacy secrets were not redacted: %#v", settings)
		}
		if len(settings.ModelProfiles) == 1 && settings.ModelProfiles[0].OpenAIAPIKey != "" {
			t.Fatalf("model profile secret was not redacted: %#v", settings.ModelProfiles)
		}
		if len(settings.ImageAPIProfiles) == 1 && settings.ImageAPIProfiles[0].OpenAIAPIKey != "" {
			t.Fatalf("image profile secret was not redacted: %#v", settings.ImageAPIProfiles)
		}
	}
	if !redacted.Default.OpenAIAPIKeyConfigured || !redacted.Default.ImageAPIKeyConfigured {
		t.Fatalf("legacy configured hints missing: %#v", redacted.Default)
	}
	if !redacted.Default.ModelProfiles[0].APIKeyConfigured || !redacted.Default.ImageAPIProfiles[0].APIKeyConfigured {
		t.Fatalf("profile configured hints missing: %#v", redacted.Default)
	}

	raw, err := json.Marshal(redacted)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"legacy-model-secret", "default-model-secret", "legacy-image-secret", "cover-image-secret"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("redacted JSON contains secret %q", secret)
		}
	}
	if string(raw) == "" {
		t.Fatal("redacted JSON is empty")
	}

	// The value passed in is copied by value; profile slices must also be
	// isolated so redaction does not mutate the server-side source snapshot.
	if layered.Default.ModelProfiles[0].OpenAIAPIKey != "default-model-secret" {
		t.Fatal("redaction mutated the source model profile")
	}
	if layered.Default.ImageAPIProfiles[0].OpenAIAPIKey != "cover-image-secret" {
		t.Fatal("redaction mutated the source image profile")
	}
}

func TestPreserveSettingsSecretsForRedactedDraft(t *testing.T) {
	existing := Settings{
		OpenAIAPIKey: "existing-model-secret",
		ModelProfiles: []ModelProfileSettings{
			{ID: "default", OpenAIAPIKey: "existing-default-secret"},
			{ID: "story", OpenAIAPIKey: "existing-story-secret"},
		},
		ImageAPIKey: "existing-image-secret",
		ImageAPIProfiles: []ImageAPIProfileSettings{
			{ID: "default", OpenAIAPIKey: "existing-image-default-secret"},
			{ID: "cover", OpenAIAPIKey: "existing-cover-secret"},
		},
	}
	incoming := Settings{
		OpenAIAPIKeyConfigured: true,
		ModelProfiles: []ModelProfileSettings{
			{ID: "default", APIKeyConfigured: true, OpenAIBaseURL: "https://example.test"},
			{ID: "story", APIKeyConfigured: true, OpenAIModel: "story-model"},
		},
		ImageAPIKeyConfigured: true,
		ImageAPIProfiles: []ImageAPIProfileSettings{
			{ID: "default", APIKeyConfigured: true, OpenAIModel: "image-model"},
			{ID: "cover", APIKeyConfigured: true},
		},
	}

	got := preserveSettingsSecrets(existing, incoming)
	if got.OpenAIAPIKey != existing.OpenAIAPIKey || got.ImageAPIKey != existing.ImageAPIKey {
		t.Fatalf("legacy secrets were not preserved: %#v", got)
	}
	if got.ModelProfiles[0].OpenAIAPIKey != "existing-default-secret" || got.ModelProfiles[1].OpenAIAPIKey != "existing-story-secret" {
		t.Fatalf("model profile secrets were not preserved: %#v", got.ModelProfiles)
	}
	if got.ImageAPIProfiles[0].OpenAIAPIKey != "existing-image-default-secret" || got.ImageAPIProfiles[1].OpenAIAPIKey != "existing-cover-secret" {
		t.Fatalf("image profile secrets were not preserved: %#v", got.ImageAPIProfiles)
	}
}

func TestPreserveSettingsSecretsAllowsNewKeys(t *testing.T) {
	existing := Settings{
		OpenAIAPIKey:  "old-model-secret",
		ModelProfiles: []ModelProfileSettings{{ID: "story", OpenAIAPIKey: "old-story-secret"}},
	}
	incoming := Settings{
		OpenAIAPIKey:           "new-model-secret",
		OpenAIAPIKeyConfigured: true,
		ModelProfiles:          []ModelProfileSettings{{ID: "story", OpenAIAPIKey: "new-story-secret", APIKeyConfigured: true}},
	}

	got := preserveSettingsSecrets(existing, incoming)
	if got.OpenAIAPIKey != "new-model-secret" || got.ModelProfiles[0].OpenAIAPIKey != "new-story-secret" {
		t.Fatalf("new secrets were overwritten: %#v", got)
	}
}
