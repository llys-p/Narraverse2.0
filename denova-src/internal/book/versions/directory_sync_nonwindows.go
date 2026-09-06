//go:build !windows

package versions

import (
	"errors"
	"io"
	"os"
)

func syncDirectory(file *os.File) error {
	if err := file.Sync(); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		return err
	}
	return nil
}
