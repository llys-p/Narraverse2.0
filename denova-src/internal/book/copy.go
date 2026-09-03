package book

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// CopyPath 复制文件或目录。
func CopyPath(from, to string) error {
	info, err := os.Stat(from)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return copyDir(from, to)
	}
	return copyFile(from, to, info.Mode())
}

// copyDir 递归复制目录，跳过隐藏文件和隐藏目录。
func copyDir(from, to string) error {
	info, err := os.Stat(from)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(to, info.Mode()); err != nil {
		return err
	}

	entries, err := os.ReadDir(from)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		src := filepath.Join(from, entry.Name())
		dst := filepath.Join(to, entry.Name())
		if err := CopyPath(src, dst); err != nil {
			return fmt.Errorf("%s: %w", entry.Name(), err)
		}
	}
	return nil
}

// copyFile 复制单个文件并保留权限。
func copyFile(from, to string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}

	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer dst.Close()

	_, err = io.Copy(dst, src)
	return err
}
