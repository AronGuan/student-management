package config

import (
	"os"
	"strconv"
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
		Port:      getenv("PORT", "8080"),
		GinMode:   getenv("GIN_MODE", "debug"),
		DBDSN:     getenv("DB_DSN", ""),
		JWTSecret: getenv("JWT_SECRET", "dev-only-secret-change-me"),
		JWTTTL:    time.Duration(getenvInt("JWT_TTL_MINUTES", 480)) * time.Minute,
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
