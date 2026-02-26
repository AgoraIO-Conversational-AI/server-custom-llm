BINARY_NAME=audio_subscriber
CURRENT_PATH=$(shell pwd)
UNAME_S := $(shell uname -s)

.PHONY: build clean run

# Build for current platform
# CGO flags are embedded in the vendored SDK Go source files (agora_service.go)
# so we just need CGO_ENABLED=1 and the SDK handles include/link paths.
build:
	@echo "Building audio_subscriber for $(UNAME_S)..."
	@mkdir -p bin
	CGO_ENABLED=1 go build -o bin/$(BINARY_NAME) -v .
	@echo ""
	@echo "Built: bin/$(BINARY_NAME)"
ifeq ($(UNAME_S),Darwin)
	@echo "Run with:"
	@echo "  DYLD_LIBRARY_PATH=$(CURRENT_PATH)/sdk/agora_sdk_mac ./bin/$(BINARY_NAME)"
else
	@echo "Run with:"
	@echo "  LD_LIBRARY_PATH=$(CURRENT_PATH)/sdk/agora_sdk ./bin/$(BINARY_NAME)"
endif

clean:
	rm -rf bin/

run: build
ifeq ($(UNAME_S),Darwin)
	DYLD_LIBRARY_PATH=$(CURRENT_PATH)/sdk/agora_sdk_mac ./bin/$(BINARY_NAME)
else
	LD_LIBRARY_PATH=$(CURRENT_PATH)/sdk/agora_sdk ./bin/$(BINARY_NAME)
endif
