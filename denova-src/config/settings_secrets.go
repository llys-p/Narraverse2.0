package config

// RedactLayeredSettingsSecrets returns a client-safe copy of a settings
// snapshot. API credentials stay in the server-side settings file and are
// represented to the UI only by boolean configured hints.
func RedactLayeredSettingsSecrets(layered LayeredSettings) LayeredSettings {
	for _, settings := range []*Settings{
		&layered.Default,
		&layered.Global,
		&layered.User,
		&layered.Workspace,
		&layered.Effective,
	} {
		redactSettingsSecrets(settings)
	}
	return layered
}

func redactSettingsSecrets(settings *Settings) {
	if settings == nil {
		return
	}
	// LayeredSettings is copied by value, so clone slices before editing their
	// elements. This keeps redaction from mutating the in-memory snapshot that
	// the caller may still hold.
	settings.ModelProfiles = append([]ModelProfileSettings(nil), settings.ModelProfiles...)
	settings.ImageAPIProfiles = append([]ImageAPIProfileSettings(nil), settings.ImageAPIProfiles...)
	if settings.OpenAIAPIKey != "" {
		settings.OpenAIAPIKey = ""
		settings.OpenAIAPIKeyConfigured = true
	}
	if settings.ImageAPIKey != "" {
		settings.ImageAPIKey = ""
		settings.ImageAPIKeyConfigured = true
	}
	for index := range settings.ModelProfiles {
		if settings.ModelProfiles[index].OpenAIAPIKey != "" {
			settings.ModelProfiles[index].OpenAIAPIKey = ""
			settings.ModelProfiles[index].APIKeyConfigured = true
		}
	}
	for index := range settings.ImageAPIProfiles {
		if settings.ImageAPIProfiles[index].OpenAIAPIKey != "" {
			settings.ImageAPIProfiles[index].OpenAIAPIKey = ""
			settings.ImageAPIProfiles[index].APIKeyConfigured = true
		}
	}
}

// preserveSettingsSecrets rehydrates only the credentials represented by the
// transient configured hints. This lets the UI submit a redacted full draft
// without erasing an existing key, while a newly entered non-empty key still
// replaces the old one. Deleted profiles remain deleted because they are not
// present in the incoming draft.
func preserveSettingsSecrets(existing, incoming Settings) Settings {
	out := incoming
	if out.OpenAIAPIKey == "" && out.OpenAIAPIKeyConfigured {
		out.OpenAIAPIKey = existing.OpenAIAPIKey
	}
	if out.ImageAPIKey == "" && out.ImageAPIKeyConfigured {
		out.ImageAPIKey = existing.ImageAPIKey
	}
	out.ModelProfiles = preserveModelProfileSecrets(existing, out.ModelProfiles)
	out.ImageAPIProfiles = preserveImageAPIProfileSecrets(existing, out.ImageAPIProfiles)
	return out
}

func preserveModelProfileSecrets(existing Settings, incoming []ModelProfileSettings) []ModelProfileSettings {
	if len(incoming) == 0 {
		return incoming
	}
	existingByID := make(map[string]ModelProfileSettings, len(existing.ModelProfiles))
	for _, profile := range existing.ModelProfiles {
		if id := modelProfileID(profile); id != "" {
			existingByID[id] = profile
		}
	}
	for index := range incoming {
		profile := &incoming[index]
		if profile.OpenAIAPIKey != "" || !profile.APIKeyConfigured {
			continue
		}
		previous, ok := existingByID[modelProfileID(*profile)]
		if ok && previous.OpenAIAPIKey != "" {
			profile.OpenAIAPIKey = previous.OpenAIAPIKey
			continue
		}
		if modelProfileID(*profile) == DefaultModelProfileID && existing.OpenAIAPIKey != "" {
			profile.OpenAIAPIKey = existing.OpenAIAPIKey
		}
	}
	return incoming
}

func preserveImageAPIProfileSecrets(existing Settings, incoming []ImageAPIProfileSettings) []ImageAPIProfileSettings {
	if len(incoming) == 0 {
		return incoming
	}
	existingByID := make(map[string]ImageAPIProfileSettings, len(existing.ImageAPIProfiles))
	for _, profile := range existing.ImageAPIProfiles {
		if id := imageAPIProfileID(profile); id != "" {
			existingByID[id] = profile
		}
	}
	for index := range incoming {
		profile := &incoming[index]
		if profile.OpenAIAPIKey != "" || !profile.APIKeyConfigured {
			continue
		}
		previous, ok := existingByID[imageAPIProfileID(*profile)]
		if ok && previous.OpenAIAPIKey != "" {
			profile.OpenAIAPIKey = previous.OpenAIAPIKey
			continue
		}
		if imageAPIProfileID(*profile) == DefaultImageAPIProfileID && existing.ImageAPIKey != "" {
			profile.OpenAIAPIKey = existing.ImageAPIKey
		}
	}
	return incoming
}
