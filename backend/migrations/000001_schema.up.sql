-- Core schema. MySQL DDL implicitly commits, so this file is not atomic;
-- it is applied to a fresh database. Grouped by domain for readability.

CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  role          ENUM('admin','teacher','student') NOT NULL,
  username      VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name  VARCHAR(120) NOT NULL,
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at    DATETIME(3) NOT NULL,
  updated_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  INDEX idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE teacher_profiles (
  user_id BIGINT UNSIGNED NOT NULL,
  bio     VARCHAR(255) NULL,
  active  TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE subjects (
  id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subjects_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE students (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_admin_id BIGINT UNSIGNED NULL,
  user_id        BIGINT UNSIGNED NULL COMMENT 'household login; a credential may hold several children',
  full_name      VARCHAR(120) NOT NULL,
  preferred_name VARCHAR(60) NULL,
  year_level     VARCHAR(30) NULL,
  status         ENUM('lead','trial','active','churned') NOT NULL DEFAULT 'lead',
  source         VARCHAR(80) NULL,
  created_at     DATETIME(3) NOT NULL,
  updated_at     DATETIME(3) NOT NULL,
  deleted_at     DATETIME(3) NULL,
  PRIMARY KEY (id),
  INDEX idx_students_owner (owner_admin_id, status),
  INDEX idx_students_status (status),
  INDEX idx_students_user (user_id),
  INDEX idx_students_name (full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE guardians (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id   BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(120) NOT NULL,
  phone        VARCHAR(40) NULL,
  email        VARCHAR(160) NULL,
  relationship VARCHAR(30) NULL COMMENT 'mother/father/other',
  is_primary   TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_guardians_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE classes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  teacher_id BIGINT UNSIGNED NOT NULL,
  weekday    TINYINT NOT NULL COMMENT '0=Monday .. 6=Sunday',
  start_min  SMALLINT NOT NULL COMMENT 'minutes from 00:00',
  end_min    SMALLINT NOT NULL,
  capacity   SMALLINT NOT NULL DEFAULT 8,
  room       VARCHAR(40) NULL,
  status     ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_class_capacity CHECK (capacity > 0),
  CONSTRAINT chk_class_time CHECK (end_min > start_min AND start_min >= 0 AND end_min <= 1440),
  INDEX idx_classes_teacher (teacher_id, weekday),
  INDEX idx_classes_subject (subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE class_enrollments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id    BIGINT UNSIGNED NOT NULL,
  student_id  BIGINT UNSIGNED NOT NULL,
  weekday     TINYINT NOT NULL COMMENT 'denormalised from class; powers uq_student_slot',
  start_min   SMALLINT NOT NULL,
  status      ENUM('active','withdrawn') NOT NULL DEFAULT 'active',
  enrolled_on DATETIME(3) NOT NULL,
  withdrawn_on DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_enroll (class_id, student_id),
  UNIQUE KEY uq_student_slot (student_id, weekday, start_min),
  INDEX idx_enroll_student (student_id, status),
  INDEX idx_enroll_class (class_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lessons (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id      BIGINT UNSIGNED NOT NULL,
  teacher_id    BIGINT UNSIGNED NOT NULL,
  lesson_date   DATE NOT NULL,
  weekday       TINYINT NOT NULL,
  start_min     SMALLINT NOT NULL,
  end_min       SMALLINT NOT NULL,
  status        ENUM('scheduled','completed','cancelled') NOT NULL DEFAULT 'scheduled',
  cancel_reason VARCHAR(255) NULL,
  created_at    DATETIME(3) NOT NULL,
  updated_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lesson (class_id, lesson_date),
  INDEX idx_lessons_date (lesson_date, teacher_id),
  INDEX idx_lessons_teacher_date (teacher_id, lesson_date),
  INDEX idx_lessons_class_date (class_id, lesson_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE attendances (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lesson_id           BIGINT UNSIGNED NOT NULL,
  student_id          BIGINT UNSIGNED NOT NULL,
  status              ENUM('present','late','absent','leave_approved','leave_late') NOT NULL,
  source              ENUM('prefilled','teacher_override','system') NOT NULL DEFAULT 'system',
  recorded_by_user_id BIGINT UNSIGNED NULL,
  recorded_at         DATETIME(3) NULL,
  note                VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_att (lesson_id, student_id),
  INDEX idx_att_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE leave_requests (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lesson_id            BIGINT UNSIGNED NOT NULL,
  student_id           BIGINT UNSIGNED NOT NULL,
  requested_by_user_id BIGINT UNSIGNED NOT NULL,
  requested_at         DATETIME(3) NOT NULL,
  reason               VARCHAR(255) NULL,
  resolution           ENUM('approved_ge_24h','late_lt_24h') NOT NULL,
  hours_before_start   INT NOT NULL,
  created_at           DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_leave (lesson_id, student_id),
  INDEX idx_leave_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE credit_packages (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id             BIGINT UNSIGNED NOT NULL,
  name                   VARCHAR(120) NOT NULL,
  total_credits          INT NOT NULL,
  price_cents            BIGINT NOT NULL DEFAULT 0,
  purchased_at           DATETIME(3) NOT NULL,
  purchased_by_admin_id  BIGINT UNSIGNED NOT NULL,
  status                 ENUM('active','void','refunded') NOT NULL DEFAULT 'active',
  expires_at             DATE NULL COMMENT 'R9: recorded, deliberately not enforced in MVP',
  PRIMARY KEY (id),
  CONSTRAINT chk_package_credits CHECK (total_credits > 0),
  INDEX idx_packages_student (student_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- R5: append-only. No updated_at, no deleted_at, on purpose.
CREATE TABLE credit_ledger (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id    BIGINT UNSIGNED NOT NULL,
  package_id    BIGINT UNSIGNED NULL,
  delta         INT NOT NULL COMMENT 'positive = in, negative = out',
  reason        ENUM('purchase','consume','leave_adjust','manual_adjust','refund','transfer_out') NOT NULL,
  lesson_id     BIGINT UNSIGNED NULL,
  attendance_id BIGINT UNSIGNED NULL,
  actor_user_id BIGINT UNSIGNED NOT NULL,
  note          VARCHAR(255) NULL,
  created_at    DATETIME(3) NOT NULL COMMENT 'written explicitly by Go in Melbourne time; never NOW()',
  PRIMARY KEY (id),
  CONSTRAINT chk_delta_nonzero CHECK (delta <> 0),
  UNIQUE KEY uq_ledger_consume (student_id, lesson_id, reason),
  INDEX idx_ledger_student (student_id, created_at),
  INDEX idx_ledger_package (package_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE trials (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id    BIGINT UNSIGNED NOT NULL,
  subject_id    BIGINT UNSIGNED NOT NULL,
  teacher_id    BIGINT UNSIGNED NULL,
  scheduled_at  DATETIME(3) NOT NULL,
  duration_min  SMALLINT NOT NULL DEFAULT 60,
  outcome       ENUM('pending','converted','lost') NOT NULL DEFAULT 'pending',
  outcome_note  VARCHAR(500) NULL,
  created_at    DATETIME(3) NOT NULL,
  updated_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_trial_once (student_id, subject_id) COMMENT 'R1 enforced at the database layer',
  INDEX idx_trials_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE follow_ups (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id            BIGINT UNSIGNED NOT NULL,
  trial_id              BIGINT UNSIGNED NULL,
  due_at                DATETIME(3) NOT NULL,
  status                ENUM('pending','done','overdue') NOT NULL DEFAULT 'pending',
  completed_at          DATETIME(3) NULL,
  completed_by_user_id  BIGINT UNSIGNED NULL,
  note                  VARCHAR(500) NULL,
  created_at            DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_followup_status (status, due_at),
  INDEX idx_followup_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE ai_decisions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  student_id    BIGINT UNSIGNED NOT NULL,
  kind          ENUM('trial_conversion','renewal_risk') NOT NULL,
  model         VARCHAR(60) NULL,
  prompt_version VARCHAR(20) NULL,
  input_hash    VARCHAR(64) NULL,
  output_json   JSON NULL,
  ai_status     ENUM('ok','invalid','unavailable') NOT NULL,
  created_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_ai_student (student_id, kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_user_id BIGINT UNSIGNED NULL,
  entity        VARCHAR(40) NOT NULL,
  entity_id     BIGINT UNSIGNED NOT NULL,
  action        VARCHAR(40) NOT NULL,
  payload_json  JSON NULL,
  created_at    DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  INDEX idx_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
