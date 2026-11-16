package main

import "fmt"

const (
	maxJSONBytes        = 48 * 1024 * 1024
	maxPayloadBytes     = 32 * 1024 * 1024
	maxTCPResponseBytes = 4 * 1024 * 1024
)

type apiError struct {
	ServiceFault        string
	FaultClearRequested bool
	Status              int
	Message             string
	Code                string
	Stage               string
	Outcome             string
	RetrySafety         string
	BytesWritten        int
	WriteStarted        bool
	WriteCompleted      bool
	JobID               string
	Sequence            int
	JobState            string
	NextSequence        int
	CheckpointState     string
	CheckpointHash      string
}

func (e *apiError) Error() string {
	return e.Message
}

func badRequest(format string, args ...any) error {
	return &apiError{Status: 400, Message: fmt.Sprintf(format, args...)}
}

func forbidden(format string, args ...any) error {
	return &apiError{Status: 403, Message: fmt.Sprintf(format, args...)}
}
