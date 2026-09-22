package handler

import (
	"net/http"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"sms/internal/config"
	"sms/internal/middleware"
	"sms/internal/model"
	"sms/internal/service"
)

// Deps is everything the HTTP layer needs. Wiring happens once in main.
type Deps struct {
	Cfg   *config.Config
	Auth  *service.AuthService
	Stu   *service.StudentService
	Cred  *service.CreditService
	Sched *service.SchedulingService
	Att   *service.AttendanceService
	Tri   *service.TrialService
	AI    *service.AIService
}

func Register(r *gin.Engine, d *Deps) {
	auth := &AuthHandler{Cfg: d.Cfg, AuthS: d.Auth}
	stu := &StudentHandler{Cfg: d.Cfg, Students: d.Stu, Credit: d.Cred}
	sch := &SchedulingHandler{Cfg: d.Cfg, Sched: d.Sched, Att: d.Att}
	tri := &TrialHandler{Cfg: d.Cfg, Trials: d.Tri}
	ai := &AIHandler{Cfg: d.Cfg, AI: d.AI, Stu: d.Stu}
	dash := &DashboardHandler{Cfg: d.Cfg}

	// Front end runs on a different origin in dev, so credentials are
	// allowed explicitly rather than wildcarded.
	//
	// Proxied requests still carry the browser's Origin verbatim: changeOrigin
	// only rewrites Host (frontend/vite.config.ts:23), so the same-origin
	// shortcut inside gin-contrib/cors (Origin == "http://" + Request.Host, that
	// module's own config.go:79) never matches behind the proxy. A missing entry
	// is therefore a hard 403 with an empty body - AbortWithStatus writes no
	// body, unlike the {code,data,message} envelope every business 403 gets
	// (handler/respond.go, middleware/auth.go). gin.Logger() is registered ahead
	// of this middleware (cmd/server/main.go:70), so the 403 IS in the access
	// log; that log line plus the empty body is what distinguishes it from a
	// role or credential failure.
	//
	// The allowlist is config-driven (config.CORS_ORIGINS) because it carries the
	// front end's port, which has already moved once.
	r.Use(cors.New(cors.Config{
		AllowOrigins:     d.Cfg.CORSOrigin,
		AllowMethods:     []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}))

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	api := r.Group("/api/v1")

	api.POST("/auth/login", auth.Login)

	authed := api.Group("")
	authed.Use(middleware.AuthRequired(d.Cfg.JWTSecret))
	{
		authed.POST("/auth/logout", auth.Logout)
		authed.GET("/auth/me", auth.Me)
		authed.GET("/config", ai.Config)

		// Students: every staff role may read; only the owning admin writes (R7).
		authed.GET("/students", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher), stu.List)
		authed.POST("/students", middleware.RequireRoles(model.RoleAdmin), stu.Create)
		authed.GET("/students/:id", stu.Get)
		authed.PATCH("/students/:id", middleware.RequireRoles(model.RoleAdmin), stu.Patch)
		authed.POST("/students/:id/transfer-owner", middleware.RequireRoles(model.RoleAdmin), stu.TransferOwner)
		authed.GET("/students/:id/credits", stu.Credits)
		// Staff only: a decision card is an internal risk judgement about a
		// family, and this route hands over the exact object GET /students/:id
		// withholds from households as latest_ai_card.
		authed.GET("/students/:id/ai-cards", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher), ai.Cards)
		authed.POST("/students/:id/credit-packages", middleware.RequireRoles(model.RoleAdmin), stu.Purchase)
		authed.POST("/students/:id/credit-adjustments", middleware.RequireRoles(model.RoleAdmin), stu.Adjustment)

		// Trials and follow-ups
		authed.GET("/trials", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher), tri.List)
		authed.POST("/trials", middleware.RequireRoles(model.RoleAdmin), tri.Create)
		authed.POST("/trials/:id/outcome", middleware.RequireRoles(model.RoleAdmin), tri.SetOutcome)
		authed.GET("/follow-ups", middleware.RequireRoles(model.RoleAdmin), tri.ListFollowUps)
		authed.POST("/follow-ups/:id/complete", middleware.RequireRoles(model.RoleAdmin), tri.CompleteFollowUp)

		// Classes and enrolment
		authed.GET("/classes", sch.ListClasses)
		authed.POST("/classes", middleware.RequireRoles(model.RoleAdmin), sch.CreateClass)
		authed.GET("/classes/:id/enrollments", sch.Enrollments)
		authed.POST("/classes/:id/enrollments", middleware.RequireRoles(model.RoleAdmin), sch.Enroll)
		authed.DELETE("/classes/:id/enrollments/:student_id", middleware.RequireRoles(model.RoleAdmin), sch.Withdraw)

		// Class-creation pickers. Admin-only: the catalogue is not part of
		// the teacher or household surface.
		authed.GET("/subjects", middleware.RequireRoles(model.RoleAdmin), sch.ListSubjects)
		authed.GET("/teachers", middleware.RequireRoles(model.RoleAdmin), sch.ListTeachers)

		// Lessons and attendance.
		// Household accounts may list lessons so they can submit a leave
		// request; the handler scopes the query to their own children.
		authed.GET("/lessons", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher, model.RoleStudent), sch.ListLessons)
		authed.POST("/lessons/generate", middleware.RequireRoles(model.RoleAdmin), sch.GenerateLessons)
		authed.POST("/lessons/cancel-range", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher), sch.CancelRange)
		authed.GET("/lessons/:id/roster", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher), sch.Roster)
		authed.POST("/lessons/:id/attendance", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher), sch.Settle)
		authed.PATCH("/lessons/:id/attendance/:student_id", middleware.RequireRoles(model.RoleAdmin, model.RoleTeacher), sch.Override)

		// Leave: a household submits, the server judges immediately
		authed.GET("/leave-requests", sch.ListLeave)
		authed.POST("/leave-requests", middleware.RequireRoles(model.RoleStudent, model.RoleAdmin), sch.RequestLeave)

		// AI decision cards (R8). The path parameter is a student id.
		authed.POST("/ai/trial-conversion/:student_id", middleware.RequireRoles(model.RoleAdmin), ai.Conversion)
		authed.POST("/ai/renewal-risk/:student_id", middleware.RequireRoles(model.RoleAdmin), ai.Renewal)

		// Dashboards
		authed.GET("/dashboard/admin", middleware.RequireRoles(model.RoleAdmin), dash.Admin)
		authed.GET("/dashboard/teacher", middleware.RequireRoles(model.RoleTeacher, model.RoleAdmin), dash.Teacher)
		authed.GET("/dashboard/household", middleware.RequireRoles(model.RoleStudent), dash.Household)
	}
}
