//go:build linux || darwin

package main

import (
	"os"
	"path/filepath"
)

// Callers sync and close the temporary file before replacing its destination.
func durableReplaceRawSpoolFile(source, destination string) error {
	if err := os.Rename(source, destination); err != nil {
		return err
	}
	if err := syncRawSpoolDirectory(filepath.Dir(destination)); err != nil {
		return err
	}
	if filepath.Clean(filepath.Dir(source)) != filepath.Clean(filepath.Dir(destination)) {
		return syncRawSpoolDirectory(filepath.Dir(source))
	}
	return nil
}

func syncRawSpoolDirectory(dir string) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
