package middleware

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"sms/internal/apierr"
	"sms/internal/clock"
	"sms/internal/model"
)

const (
	// CookieName is the browser channel.
	CookieName = "ae_token"
	// ctxKey carries the caller identity.
	ctxKey = "currentUser"
)

// CurrentUser is the authenticated caller.
type CurrentUser struct {
	ID   uint64
	Role model.Role
	Name string
}

type Claims struct {
	UserID uint64     `json:"uid"`
	Role   model.Role `json:"role"`
	Name   string     `json:"name"`
	jwt.RegisteredClaims
}

// Issue signs a token. TTL is deliberately short-ish (8h) with no refresh:
// this is an internal ops tool, and a single credential keeps the curl
// story simple for review.
func Issue(secret string, ttl time.Duration, u *model.User) (string, error) {
	now := clock.Now()
	c := Claims{
		UserID: u.ID,
		Role:   u.Role,
		Name:   u.DisplayName,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			Subject:   u.Username,
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secret))
}

// Parse validates a raw token string.
func Parse(secret, raw string) (*Claims, error) {
	c := &Claims{}
	tok, err := jwt.ParseWithClaims(raw, c, func(*jwt.Token) (interface{}, error) {
		return []byte(secret), nil
	})
	if err != nil || !tok.Valid {
		return nil, err
	}
	return c, nil
}

// AuthRequired accepts the token from either the httpOnly cookie (browser)
// or Authorization: Bearer (curl). The second channel exists on purpose:
// the review session tests rules by hitting the API directly, bypassing
// the UI entirely.
func AuthRequired(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := ""
		if v, err := c.Cookie(CookieName); err == nil && v != "" {
			raw = v
		}
		if raw == "" {
			h := c.GetHeader("Authorization")
			if strings.HasPrefix(strings.ToLower(h), "bearer ") {
				raw = strings.TrimSpace(h[7:])
			}
		}
		if raw == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": apierr.CodeUnauthorized, "message": apierr.ErrUnauthorized.Message, "data": nil})
			return
		}
		claims, err := Parse(secret, raw)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"code": apierr.CodeUnauthorized, "message": apierr.ErrUnauthorized.Message, "data": nil})
			return
		}
		c.Set(ctxKey, &CurrentUser{ID: claims.UserID, Role: claims.Role, Name: claims.Name})
		c.Next()
	}
}

// RequireRoles allows only the listed roles.
func RequireRoles(roles ...model.Role) gin.HandlerFunc {
	allow := map[model.Role]bool{}
	for _, r := range roles {
		allow[r] = true
	}
	return func(c *gin.Context) {
		cu := Current(c)
		if cu == nil || !allow[cu.Role] {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": apierr.CodeForbidden, "message": apierr.ErrForbidden.Message, "data": nil})
			return
		}
		c.Next()
	}
}

func Current(c *gin.Context) *CurrentUser {
	v, ok := c.Get(ctxKey)
	if !ok {
		return nil
	}
	cu, _ := v.(*CurrentUser)
	return cu
}
