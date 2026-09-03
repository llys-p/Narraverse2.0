package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"denova/internal/book"
)

func main() {
	workspace := flag.String("workspace", "", "任意现有冒险工作目录")
	flag.Parse()
	if *workspace == "" {
		fmt.Fprintln(os.Stderr, "缺少 -workspace")
		os.Exit(2)
	}
	result, err := book.NewMasterLibraryStore(*workspace).MigrateLegacyWorldbookEntries()
	if err != nil {
		fmt.Fprintf(os.Stderr, "迁移失败: %v\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
}
