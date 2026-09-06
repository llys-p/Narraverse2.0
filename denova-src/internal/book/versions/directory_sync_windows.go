//go:build windows

package versions

import "os"

// Directory Sync is unsupported for the read-only directory handles returned
// by os.Root on Windows. The restored file is flushed before the rename.
func syncDirectory(_ *os.File) error {
	return nil
}
