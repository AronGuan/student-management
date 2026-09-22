package config

import (
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

// Thresholds are business assumptions with no external source of truth.
// They live here so the UI can read them back through GET /api/v1/config
// instead of hard-coding 48 / 24 / 4 a second time and drifting.
type Thresholds struct {
	FollowUpSLAHours   int `json:"followup_sla_hours"`
	LeaveNoticeHours   int `json:"leave_notice_hours"`
	LowCreditThreshold int `json:"low_credit_threshold"`
}

type Config struct {
	Port       string
	GinMode    string
	DBDSN      string
	JWTSecret  string
	JWTTTL     time.Duration
	CORSOrigin []string
	DeepSeek   DeepSeekConfig
	Thresholds Thresholds
}

type DeepSeekConfig struct {
	APIKey     string
	BaseURL    string
	Model      string
	TimeoutSec int
}

func Load() (*Config, error) {
	_ = godotenv.Load()          // repo-local .env
	_ = godotenv.Load("../.env") // when running from backend/

	return &Config{
		Port:      getenv("PORT", "19080"),
		GinMode:   getenv("GIN_MODE", "debug"),
		DBDSN:     getenv("DB_DSN", ""),
		JWTSecret: getenv("JWT_SECRET", "dev-only-secret-change-me"),
		JWTTTL:    time.Duration(getenvInt("JWT_TTL_MINUTES", 480)) * time.Minute,
		// The browser normally reaches the API through the front end's own
		// origin (Vite's proxy in dev, the preview server when deployed), so
		// this list is not on the happy path - a same-origin request never
		// triggers CORS. It exists for callers that go direct.
		//
		// Configurable rather than hardcoded because the moment this runs
		// anywhere but a laptop the allowed origin is a host name, and a stale
		// allowlist fails as a preflight rejection with no body and no server
		// log line - the browser reports a CORS error and the API looks fine.
		CORSOrigin: getenvList("CORS_ORIGINS", []string{
			"http://localhost:19073",
			"http://127.0.0.1:19073",
		}),
		DeepSeek: DeepSeekConfig{
			APIKey:     getenv("DEEPSEEK_API_KEY", ""),
			BaseURL:    getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
			Model:      getenv("DEEPSEEK_MODEL", "deepseek-chat"),
			TimeoutSec: getenvInt("LLM_TIMEOUT_SECONDS", 20),
		},
		Thresholds: Thresholds{
			FollowUpSLAHours:   getenvInt("FOLLOWUP_SLA_HOURS", 48),
			LeaveNoticeHours:   getenvInt("LEAVE_NOTICE_HOURS", 24),
			LowCreditThreshold: getenvInt("LOW_CREDIT_THRESHOLD", 4),
		},
	}, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// getenvList reads a comma-separated env var. Entries are trimmed and empties
// dropped, so a trailing comma in a hand-written .env does not add an empty
// origin - which gin-contrib/cors would compare against and never match.
func getenvList(k string, def []string) []string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	out := make([]string, 0, len(def))
	for _, part := range strings.Split(v, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}
