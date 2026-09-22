package handler

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"sms/internal/apierr"
	"sms/internal/clock"
)

// DB is bound once at startup; handlers never open connections themselves.
var DB *gorm.DB

// Handler-level input faults. All three are the caller's to fix, so they
// are 40000 rather than the 50000 catch-all they used to fall into.
var (
	errBadID    = apierr.BadRequest("路径参数必须是合法的数字 id")
	errBadBody  = apierr.BadRequest("请求体格式错误或缺少必填字段")
	errNoFields = apierr.BadRequest("没有可更新的字段")
)

func joinSets(sets []string) string { return strings.Join(sets, ", ") }

// nowDB returns business wall-clock in the format MySQL expects. Handlers
// pass it into queries as a parameter rather than using SQL NOW(), because
// the server's session timezone is CST while the business runs on
// Melbourne time (ADR-007).
func nowDB() string { return clock.Now().Format("2006-01-02 15:04:05") }

func nowDate() string { return clock.Now().Format("2006-01-02") }

func minutesToClock(m int) string { return fmt.Sprintf("%02d:%02d", m/60, m%60) }

// Envelope is the only response shape in the system.
type Envelope struct {
	Code    int         `json:"code"`
	Data    interface{} `json:"data"`
	Message string      `json:"message,omitempty"`
}

// Page is the standard list wrapper.
type Page struct {
	Items   interface{} `json:"items"`
	Total   int64       `json:"total"`
	Page    int         `json:"page"`
	Limit   int         `json:"limit"`
	HasMore bool        `json:"has_more"`
}

func OK(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, Envelope{Code: apierr.CodeOK, Data: data})
}

func Created(c *gin.Context, data interface{}) {
	c.JSON(http.StatusCreated, Envelope{Code: apierr.CodeOK, Data: data})
}

// internalMessage is the only thing an unclassified failure tells the
// caller. The real error goes to the log instead: it is written for an
// operator, not for a user, and echoing it back leaked SQL fragments,
// table names and driver text into the response body.
const internalMessage = "服务器内部错误，请稍后重试。"

func Fail(c *gin.Context, err error) {
	if e, ok := err.(*apierr.APIError); ok {
		c.JSON(e.HTTP, Envelope{Code: e.Code, Data: nil, Message: e.Message})
		return
	}
	log.Printf("unhandled error on %s %s: %v", c.Request.Method, c.Request.URL.Path, err)
	c.JSON(http.StatusInternalServerError, Envelope{Code: apierr.CodeInternal, Data: nil, Message: internalMessage})
}

// FailWith is for the failures that have no *apierr.APIError to carry them:
// bind errors, token problems, disabled accounts.
func FailWith(c *gin.Context, status, code int, message string) {
	c.JSON(status, Envelope{Code: code, Data: nil, Message: message})
}

// queryUint reads an optional numeric filter from the query string.
//
//	ok  = false, bad = false -> the filter was absent
//	ok  = true               -> use the value
//	bad = true               -> unparseable; the 400 is already written and
//	                            the caller must return immediately
//
// An unparseable filter is rejected rather than dropped. Dropping it is the
// dangerous option: the predicate disappears, the query falls back to the
// unfiltered set, and the caller receives every row while believing the
// result was narrowed to the one they asked for.
func queryUint(c *gin.Context, key string) (val uint64, ok bool, bad bool) {
	raw := c.Query(key)
	if raw == "" {
		return 0, false, false
	}
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		FailWith(c, http.StatusBadRequest, apierr.CodeBadRequest, key+" 必须是数字")
		return 0, false, true
	}
	return v, true, false
}

// pageParams is the single paging convention: page defaults to 1, limit
// defaults to 20, and limit is capped at 200.
//
// The clamp has to happen here rather than being left to the service,
// because the returned limit is echoed back in the Page envelope and the
// client divides total by it to work out how many pages exist. Reporting a
// limit the query did not actually apply makes every page count wrong from
// the first page on - the caller sees limit=500 next to 20 rows and
// computes a page count that does not exist.
//
// Out-of-range values fall back to 20 instead of a 400: a paging parameter
// only decides "how many", it does not change the *scope* of what is
// visible, so the caller still gets a correct slice of the right set. That
// is the line ADR-010 draws for the 400 rule, which is reserved for filters
// whose loss would widen the result set (see queryUint above).
func pageParams(c *gin.Context) (page, limit int) {
	page, _ = strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ = strconv.Atoi(c.DefaultQuery("limit", "20"))
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 200 {
		limit = 20
	}
	return page, limit
}
