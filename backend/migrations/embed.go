// Package migrations embeds the SQL files so the binary can migrate
// itself. The files follow the golang-migrate naming convention
// (NNNNNN_name.up.sql / .down.sql), so the official CLI works against them
// too if you prefer it.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
