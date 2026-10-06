package app

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"denova/config"
)

func TestConfigManagerCharacterTierSkillDiscovery(t *testing.T) {
	for _, instruction := range []string{"区分主次人物并保存", "修改人物层级", "把次要人物折叠", "set character_tier to minor"} {
		got := configManagerResourceSkillNames(ConfigManagerRequest{Instruction: instruction})
		want := []string{configManagerLoreSkill, configManagerBookSettingSkill}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%q skills=%v, want %v", instruction, got, want)
		}
	}
}

func TestConfigManagerCharacterTierShippedSkillLoads(t *testing.T) {
	builtin, err := filepath.Abs(filepath.Join("..", "..", "skills"))
	if err != nil {
		t.Fatal(err)
	}
	loaded := loadConfigManagerResourceSkills(context.Background(), &config.Config{SkillsDir: builtin}, ConfigManagerRequest{Origin: "lore"})
	if len(loaded) != 2 || !strings.Contains(loaded[1].Content, "character_tier") || !strings.Contains(loaded[1].Content, "read_lore_items") {
		t.Fatalf("shipped book skill must describe saved tiers and read-back: %#v", loaded)
	}
}
