package api

import "testing"

func TestShouldServeSPAFallback(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/", want: true},
		{path: "/?mode=narraverse", want: true},
		{path: "/settings", want: true},
		{path: "/narraverse/play/world-1", want: true},
		{path: "/api/unknown", want: false},
		{path: "/assets/SettingsView-old.js", want: false},
		{path: "/assets/app.css", want: false},
		{path: "/favicon.svg", want: false},
	}
	for _, tt := range tests {
		if got := shouldServeSPAFallback(tt.path); got != tt.want {
			t.Errorf("shouldServeSPAFallback(%q) = %v, want %v", tt.path, got, tt.want)
		}
	}
}
