package main

import (
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/gin-gonic/gin"

	"sms/internal/clock"
	"sms/internal/config"
	"sms/internal/handler"
	"sms/internal/migrate"
	"sms/internal/repo"
	"sms/internal/seed"
	"sms/internal/service"
	"sms/migrations"
)

func main() {
	runMigrate := flag.Bool("migrate", false, "apply pending migrations and exit")
	runSeed := flag.Bool("seed", false, "load demo data and exit")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	// The schema may not exist on a fresh instance; create it before GORM
	// tries to connect, otherwise first run fails with "unknown database".
	if created, err := repo.EnsureDatabase(cfg.DBDSN); err != nil {
		log.Fatalf("database bootstrap: %v", err)
	} else if created {
		fmt.Println("created database from DB_DSN")
	}

	if err := repo.Init(cfg.DBDSN, cfg.GinMode == "debug"); err != nil {
		log.Fatalf("db: %v", err)
	}

	if *runMigrate {
		ran, err := migrate.Apply(repo.DB, migrations.FS)
		if err != nil {
			log.Fatalf("migrate: %v", err)
		}
		if len(ran) == 0 {
			fmt.Println("schema already up to date")
		} else {
			fmt.Printf("applied %d migration(s): %v\n", len(ran), ran)
		}
		return
	}

	if *runSeed {
		if err := seed.Run(repo.DB, cfg); err != nil {
			log.Fatalf("seed: %v", err)
		}
		return
	}

	handler.DB = repo.DB

	// Fail fast and loudly if the database is not ready: a half-migrated
	// schema produces confusing runtime errors otherwise.
	assertSchema()

	gin.SetMode(cfg.GinMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())

	handler.Register(r, &handler.Deps{
		Cfg:   cfg,
		Auth:  &service.AuthService{},
		Stu:   &service.StudentService{},
		Cred:  &service.CreditService{},
		Sched: &service.SchedulingService{},
		Att:   &service.AttendanceService{},
		Tri:   &service.TrialService{},
		AI:    &service.AIService{Cfg: cfg},
	})

	addr := ":" + cfg.Port
	fmt.Printf("listening on %s  (business timezone %s, now %s)\n",
		addr, clock.TimezoneName, clock.Now().Format("2006-01-02 15:04:05"))
	if err := r.Run(addr); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func assertSchema() {
	var tables int
	if err := repo.DB.Raw(`SELECT COUNT(*) FROM information_schema.tables
		WHERE table_schema = DATABASE() AND table_name IN ('users','students','credit_ledger')`).
		Scan(&tables).Error; err != nil {
		log.Fatalf("schema check failed: %v", err)
	}
	if tables < 3 {
		fmt.Fprintln(os.Stderr, "schema is not loaded. run: go run ./cmd/server -migrate")
		os.Exit(1)
	}

	// These two facts were verified against the live instance and the
	// design depends on both (ADR-007, ADR-008). Log them so a different
	// database does not silently violate an assumption.
	var version string
	_ = repo.DB.Raw("SELECT VERSION()").Scan(&version).Error
	var tz string
	_ = repo.DB.Raw("SELECT @@system_time_zone").Scan(&tz).Error
	fmt.Printf("mysql %s (>=8.0.16 required for CHECK), system_time_zone=%s\n", version, tz)
	if tz == "CST" {
		fmt.Println("note: server timezone is CST; business time is written by Go in Melbourne (ADR-007)")
	}
}
