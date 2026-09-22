package service

import (
	"errors"

	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"sms/internal/model"
)

type AuthService struct{}

// Login checks the password hash and returns the user. The same code path
// serves all three roles; authorisation is a separate concern handled by
// middleware and R7.
func (s *AuthService) Login(db *gorm.DB, username, password string) (*model.User, error) {
	u := &model.User{}
	if err := db.Raw("SELECT * FROM users WHERE username = ? AND status = 'active'", username).Scan(u).Error; err != nil {
		return nil, err
	}
	if u.ID == 0 {
		return nil, errors.New("invalid username or password")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)); err != nil {
		return nil, errors.New("invalid username or password")
	}
	return u, nil
}

func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
