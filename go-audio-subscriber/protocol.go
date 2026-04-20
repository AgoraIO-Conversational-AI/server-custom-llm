package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"sync"
)

// Frame types for stdout binary protocol
const (
	FrameTypeJSON  byte = 0x01
	FrameTypePCM   byte = 0x02
)

// StatusMessage is a JSON status sent to Node.js via stdout
type StatusMessage struct {
	Type    string `json:"type"`
	Status  string `json:"status,omitempty"`
	Message string `json:"message,omitempty"`
	UID     string `json:"uid,omitempty"`
	Error   string `json:"error,omitempty"`
}

type StreamMessage struct {
	Type     string `json:"type"`
	UID      string `json:"uid"`
	StreamID int    `json:"stream_id"`
	Data     string `json:"data"`
}

// FrameWriter writes framed binary data to stdout.
// Protocol: [1-byte type][4-byte BE length][payload]
type FrameWriter struct {
	w    io.Writer
	mu   sync.Mutex
}

// NewFrameWriter creates a new FrameWriter
func NewFrameWriter(w io.Writer) *FrameWriter {
	return &FrameWriter{w: w}
}

// WriteJSON sends a JSON status frame (type 0x01)
func (fw *FrameWriter) WriteJSON(msg *StatusMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return fw.writeFrame(FrameTypeJSON, data)
}

func (fw *FrameWriter) WriteObject(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return fw.writeFrame(FrameTypeJSON, data)
}

// WritePCM sends a raw PCM audio frame (type 0x02)
func (fw *FrameWriter) WritePCM(pcm []byte) error {
	return fw.writeFrame(FrameTypePCM, pcm)
}

// writeFrame writes a single framed message: [type][length BE 4][payload]
func (fw *FrameWriter) writeFrame(frameType byte, payload []byte) error {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	header := make([]byte, 5)
	header[0] = frameType
	binary.BigEndian.PutUint32(header[1:5], uint32(len(payload)))

	if _, err := fw.w.Write(header); err != nil {
		return err
	}
	if _, err := fw.w.Write(payload); err != nil {
		return err
	}
	return nil
}
