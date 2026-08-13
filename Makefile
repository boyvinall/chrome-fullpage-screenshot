EXT_DIR    := src
DIST_DIR   := dist
NAME       := chrome-fullpage-screenshot
VERSION    := $(shell python3 -c "import json;print(json.load(open('$(EXT_DIR)/manifest.json'))['version'])")
STAGE_DIR  := $(DIST_DIR)/$(NAME)
ZIP_FILE   := $(DIST_DIR)/$(NAME)-$(VERSION).zip

.PHONY: help all build zip lint clean

#: build the zip package (default)
all: zip

#: validate manifest.json
lint:
	@python3 -m json.tool "$(EXT_DIR)/manifest.json" > /dev/null
	@echo "manifest.json is valid JSON"

# Stage a clean copy of the extension (no build step needed — it's plain
# HTML/CSS/JS — but this is where a bundler/minifier would slot in later).
#: stage a clean copy of the extension
build: lint
	rm -rf "$(STAGE_DIR)"
	mkdir -p "$(STAGE_DIR)"
	cp -R "$(EXT_DIR)/." "$(STAGE_DIR)/"

#: build and zip the extension
zip: build
	rm -f "$(ZIP_FILE)"
	cd "$(DIST_DIR)" && zip -r -q "$(NAME)-$(VERSION).zip" "$(NAME)"
	@echo "built $(ZIP_FILE)"

#: remove build artifacts
clean:
	rm -rf "$(DIST_DIR)"

#: print Makefile targets and short descriptions
help:
	@echo "make targets:\n"
	@awk '/^#:[[:space:]]/ { sub(/^#:[[:space:]]*/, ""); desc=$$0; next } \
		/^[[:space:]]*$$/ { next } \
		/^#/ { next } \
		/^[a-zA-Z][a-zA-Z0-9_.-]*:/ { \
			if (desc != "") { \
				split($$0, a, ":"); \
				tgt=a[1]; \
				gsub(/^[[:space:]]+|[[:space:]]+$$/, "", tgt); \
				printf "  %-18s %s\n", tgt, desc; \
				desc="" \
			} \
		}' $(firstword $(MAKEFILE_LIST))
