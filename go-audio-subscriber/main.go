// audio_subscriber is a child process that joins an Agora channel and pipes
// raw PCM audio frames to stdout using a binary framing protocol.
//
// stdin:  newline-delimited JSON commands from Node.js parent
// stdout: framed binary [1-byte type][4-byte BE length][payload]
//         type 0x01 = JSON status, type 0x02 = PCM audio
// stderr: logging (captured by Node.js parent)
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"os"
)

var (
	logger         *log.Logger
	originalStdout *os.File
)

// Command represents a JSON command from the Node.js parent
type Command struct {
	Type      string `json:"type"`
	AppID     string `json:"appId"`
	Channel   string `json:"channel"`
	BotUID    string `json:"botUid"`
	Token     string `json:"token"`
	TargetUID string `json:"targetUid"`
}

func main() {
	// Save original stdout for IPC before Agora SDK can pollute it
	originalStdout = os.Stdout

	// Redirect stdout to /dev/null so Agora SDK logs don't corrupt the binary protocol
	devNull, err := os.OpenFile("/dev/null", os.O_WRONLY, 0)
	if err != nil {
		log.Fatalf("Failed to open /dev/null: %v", err)
	}
	os.Stdout = devNull

	// All logging goes to stderr (parent captures it)
	logger = log.New(os.Stderr, "[audio_sub] ", log.LstdFlags|log.Lshortfile)
	logger.Println("Audio subscriber process started")

	// Create frame writer on the original stdout
	writer := NewFrameWriter(originalStdout)

	// Send startup status
	writer.WriteJSON(&StatusMessage{
		Type:    "status",
		Status:  "started",
		Message: "Audio subscriber ready for commands",
	})

	// Create subscriber
	subscriber := NewSubscriber(writer)

	// Read commands from stdin
	scanner := bufio.NewScanner(os.Stdin)
	// Increase buffer for potentially large JSON
	scanner.Buffer(make([]byte, 64*1024), 64*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var cmd Command
		if err := json.Unmarshal(line, &cmd); err != nil {
			logger.Printf("Error parsing command: %v", err)
			writer.WriteJSON(&StatusMessage{
				Type:  "error",
				Error: "Invalid JSON command: " + err.Error(),
			})
			continue
		}

		logger.Printf("Received command: %s", cmd.Type)

		switch cmd.Type {
		case "start":
			if cmd.AppID == "" || cmd.Channel == "" {
				writer.WriteJSON(&StatusMessage{
					Type:  "error",
					Error: "Missing appId or channel in start command",
				})
				continue
			}

			// Run subscriber (blocks until stop or target leaves)
			go func() {
				if err := subscriber.Start(cmd.AppID, cmd.Channel, cmd.BotUID, cmd.Token, cmd.TargetUID); err != nil {
					logger.Printf("Subscriber error: %v", err)
					writer.WriteJSON(&StatusMessage{
						Type:  "error",
						Error: err.Error(),
					})
				}
				writer.WriteJSON(&StatusMessage{
					Type:    "status",
					Status:  "stopped",
					Message: "Subscriber stopped",
				})
			}()

		case "stop":
			logger.Println("Stop command received")
			subscriber.Stop()
			writer.WriteJSON(&StatusMessage{
				Type:    "status",
				Status:  "stopped",
				Message: "Subscriber stopped by command",
			})
			logger.Println("Exiting")
			return

		default:
			logger.Printf("Unknown command type: %s", cmd.Type)
			writer.WriteJSON(&StatusMessage{
				Type:  "error",
				Error: "Unknown command: " + cmd.Type,
			})
		}
	}

	if err := scanner.Err(); err != nil && err != io.EOF {
		logger.Printf("Scanner error: %v", err)
	}

	// Parent closed stdin, clean up
	logger.Println("Parent closed stdin, shutting down")
	subscriber.Stop()
}
