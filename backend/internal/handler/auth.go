package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"sms/internal/apierr"
	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/model"
	"sms/internal/service"
)

type AuthHandler struct {
	Cfg   *config.Config
	AuthS *service.AuthService
}

type loginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

// publicUser is the single projection of a user into API shape. Keeping it
// in one place is what stops /auth/login and /auth/me from drifting apart;
// password_hash is never reachable from here.
func publicUser(u *model.User) gin.H {
	return gin.H{
		"id":           u.ID,
		"role":         u.Role,
		"username":     u.Username,
		"display_name": u.DisplayName,
		"status":       u.Status,
	}
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		FailWith(c, http.StatusBadRequest, apierr.CodeBadRequest, "username 和 password 均为必填")
		return
	}
	u, err := h.AuthS.Login(DB, req.Username, req.Password)
	if err != nil {
		FailWith(c, http.StatusUnauthorized, apierr.CodeUnauthorized, "用户名或密码错误")
		return
	}
	tok, err := middleware.Issue(h.Cfg.JWTSecret, h.Cfg.JWTTTL, u)
	if err != nil {
		// Signing failure is not the caller's fault, so it takes the
		// generic path: the error is logged, never echoed back.
		Fail(c, err)
		return
	}

	// Two channels on purpose: the browser uses an httpOnly cookie, while
	// a reviewer demonstrating that rules hold server-side can simply
	// curl with Authorization: Bearer.
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(middleware.CookieName, tok, int(h.Cfg.JWTTTL.Seconds()), "/", "", false, true)

	OK(c, gin.H{"token": tok, "user": publicUser(u)})
}

func (h *AuthHandler) Logout(c *gin.Context) {
	c.SetCookie(middleware.CookieName, "", -1, "/", "", false, true)
	OK(c, gin.H{"ok": true})
}

// Me re-reads the user row rather than trusting the token claims, so a
// disabled account stops working on its next request instead of at token
// expiry, and the response can carry the fields the UI needs to render
// the shell (username, status).
func (h *AuthHandler) Me(c *gin.Context) {
	cu := middleware.Current(c)
	if cu == nil {
		Fail(c, apierr.ErrUnauthorized)
		return
	}
	u := &model.User{}
	if err := DB.Raw("SELECT * FROM users WHERE id = ?", cu.ID).Scan(u).Error; err != nil || u.ID == 0 {
		Fail(c, apierr.ErrUnauthorized)
		return
	}
	if u.Status != "active" {
		FailWith(c, http.StatusForbidden, apierr.CodeForbidden, "账号已被停用")
		return
	}

	// Always an array, never absent: the household credential may hold more
	// than one child, and a missing key would force every caller to guard
	// for undefined (see docs/openapi.yaml /auth/me).
	ids := []uint64{}
	if u.Role == model.RoleStudent {
		_ = DB.Raw("SELECT id FROM students WHERE user_id = ? AND deleted_at IS NULL", u.ID).Scan(&ids)
	}
	OK(c, gin.H{"user": publicUser(u), "student_ids": ids})
}
