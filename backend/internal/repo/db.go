package repo

import (
	"database/sql"
	"fmt"
	"strings"

	drivermysql "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

var DB *gorm.DB

// Init opens the pool. The DSN carries loc=Australia%2FMelbourne so
// DATETIME columns are parsed as Melbourne wall-clock rather than UTC.
func Init(dsn string, debug bool) error {
	if dsn == "" {
		return fmt.Errorf("DB_DSN is empty; copy .env.example to .env and fill it in")
	}
	level := logger.Warn
	if debug {
		level = logger.Info
	}
	db, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(level),
		// Translate MySQL 1062 into gorm.ErrDuplicatedKey so service code can
		// turn a uniqueness violation into a business error instead of a 500.
		TranslateError: true,
	})
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	DB = db
	return nil
}

// EnsureDatabase creates the schema named in the DSN if it does not exist.
//
// It opens a server-level connection (DSN with the database stripped) because
// MySQL refuses to connect to a database that has not been created yet, which
// makes a first-run "go run ./cmd/server -migrate" impossible otherwise.
func EnsureDatabase(dsn string) (bool, error) {
	cfg, err := drivermysql.ParseDSN(dsn)
	if err != nil {
		return false, fmt.Errorf("parse DSN: %w", err)
	}
	name := cfg.DBName
	if name == "" {
		return false, fmt.Errorf("DB_DSN has no database name")
	}
	cfg.DBName = ""
	server, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return false, err
	}
	defer server.Close()

	var exists int
	if err := server.QueryRow(
		"SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ?", name,
	).Scan(&exists); err != nil {
		return false, err
	}
	if exists > 0 {
		return false, nil
	}
	// Identifiers cannot be parameterised; the DSN is operator-supplied
	// configuration, not user input, and the name is quoted defensively.
	if _, err := server.Exec("CREATE DATABASE `" + strings.ReplaceAll(name, "`", "") +
		"` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"); err != nil {
		return false, fmt.Errorf("create database %s: %w", name, err)
	}
	return true, nil
}

// Tx runs fn inside a transaction, rolling back on error.
func Tx(fn func(tx *gorm.DB) error) error {
	return DB.Transaction(fn)
}
