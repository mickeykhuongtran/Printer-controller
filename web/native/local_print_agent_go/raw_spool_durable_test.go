package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRawSpoolDurableReplace(t *testing.T) {
	dir := t.TempDir()
	destination := filepath.Join(dir, "manifest.json")
	for _, data := range []string{"queued", "spooling", "spool-accepted"} {
		file, err := os.CreateTemp(dir, ".write-*.tmp")
		if err != nil {
			t.Fatal(err)
		}
		source := file.Name()
		if _, err = file.WriteString(data); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err = file.Sync(); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err = file.Close(); err != nil {
			t.Fatal(err)
		}
		if err = durableReplaceRawSpoolFile(source, destination); err != nil {
			t.Fatal(err)
		}
		actual, err := os.ReadFile(destination)
		if err != nil || string(actual) != data {
			t.Fatalf("replacement mismatch: %q %v", actual, err)
		}
		if _, err = os.Stat(source); !os.IsNotExist(err) {
			t.Fatalf("source survived replacement: %v", err)
		}
	}
}

func TestRawSpoolDirectoryMetadataSync(t *testing.T) {
	if err := syncRawSpoolDirectory(t.TempDir()); err != nil {
		t.Fatal(err)
	}
}
