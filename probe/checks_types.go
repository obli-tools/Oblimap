package main

// ─── Device Checks: wire types ───────────────────────────────────────────────
//
// Declarative checks on third-party LAN devices (first use case: the Barix
// "now playing" check), executed by the probe. These types mirror the "Probe
// wire" section of shared/src/deviceChecks.ts: every JSON tag is identical to
// the TypeScript field name. The server builds the per-probe assignment
// (config.deviceChecks) and evaluates the assertions; the probe only binds the
// target, fetches, extracts, transforms, coerces and runs the regex tests.

// deviceChecksCapability is advertised in the push body and the WS hello. The
// server builds a deviceChecks config only for probes advertising it.
const deviceChecksCapability = "device_checks:1"

// deviceChecksPlaintextSecretsCapability is advertised as well when the local
// policy sets allowPlaintextSecrets (DEVICE_CHECKS_PLAINTEXT_SECRETS_CAPABILITY):
// the server then may send credentials over plain http, if it allows it too.
const deviceChecksPlaintextSecretsCapability = "device_checks_plaintext_secrets:1"

// DeviceChecksConfig is ProbeDeviceChecksConfig: the assignment of one probe.
type DeviceChecksConfig struct {
	V              int           `json:"v"`
	Rev            string        `json:"rev"`
	MaxConcurrency int           `json:"maxConcurrency"`
	Rules          []CheckRule   `json:"rules"`
	Targets        []CheckTarget `json:"targets"`
}

// CheckSchedule is DeviceCheckSchedule.
type CheckSchedule struct {
	IntervalSeconds int `json:"intervalSeconds"`
	JitterSeconds   int `json:"jitterSeconds"`
	TimeoutMs       int `json:"timeoutMs"`
}

// CheckEnumValue is one entry of DeviceCheckField.enumValues. The wire rule
// normally carries only key / valueType / maxLength; when the server also
// sends enumValues the probe enforces membership (otherwise the server does).
type CheckEnumValue struct {
	Value string `json:"value"`
}

// CheckField is Pick<DeviceCheckField, 'key' | 'valueType' | 'maxLength'>
// (plus the optional enumValues, see CheckEnumValue).
type CheckField struct {
	Key        string           `json:"key"`
	ValueType  string           `json:"valueType"` // string | number | boolean | enum
	MaxLength  int              `json:"maxLength,omitempty"`
	EnumValues []CheckEnumValue `json:"enumValues,omitempty"`
}

// CheckRequest is DeviceCheckRequest.
type CheckRequest struct {
	Scheme          string `json:"scheme"` // http | https
	Port            int    `json:"port"`
	Method          string `json:"method"` // GET | HEAD
	Path            string `json:"path"`
	Accept          string `json:"accept"`
	Auth            string `json:"auth"` // none | basic
	MaxBodyBytes    int    `json:"maxBodyBytes"`
	FollowRedirects int    `json:"followRedirects"`
	TLSSkipVerify   bool   `json:"tlsSkipVerify"`
	ExpectStatus    []int  `json:"expectStatus"`
	Charset         string `json:"charset"` // auto | utf-8 | iso-8859-1 | windows-1252
}

// CheckTransform is DeviceCheckTransform (a tagged union on op).
type CheckTransform struct {
	Op      string            `json:"op"`
	Values  map[string]string `json:"values,omitempty"`  // map
	Default *string           `json:"default,omitempty"` // map
	Max     int               `json:"max,omitempty"`     // truncate
	Value   *string           `json:"value,omitempty"`   // default
}

// CheckExtractor is DeviceCheckExtractor (a tagged union on type).
type CheckExtractor struct {
	Field      string           `json:"field"`
	Type       string           `json:"type"`             // regex | json | xml | httpStatus | durationMs
	Source     string           `json:"source,omitempty"` // regex: body | header
	Header     string           `json:"header,omitempty"` // regex with source=header
	Pattern    string           `json:"pattern,omitempty"`
	Group      int              `json:"group,omitempty"`
	Path       string           `json:"path,omitempty"` // json: a.b[0].c ; xml: /a/b/c or /a/b/@attr
	Transforms []CheckTransform `json:"transforms,omitempty"`
	Required   bool             `json:"required,omitempty"`
}

// CheckVariant is DeviceCheckVariant.
type CheckVariant struct {
	ID      string           `json:"id"`
	Label   string           `json:"label,omitempty"`
	Request CheckRequest     `json:"request"`
	Extract []CheckExtractor `json:"extract"`
}

// CheckRegexTest is one entry of ProbeCheckRule.regexTests (built by the
// server from the enabled matches / notMatches assertions).
type CheckRegexTest struct {
	ID      string `json:"id"`
	Field   string `json:"field"`
	Pattern string `json:"pattern"`
}

// CheckRule is ProbeCheckRule.
type CheckRule struct {
	ID         int              `json:"id"`
	Rev        int              `json:"rev"`
	Schedule   CheckSchedule    `json:"schedule"`
	RequireMac bool             `json:"requireMac"`
	Fields     []CheckField     `json:"fields"`
	Variants   []CheckVariant   `json:"variants"`
	RegexTests []CheckRegexTest `json:"regexTests"`
}

// CheckCredentials holds Basic auth credentials for one target. They live in
// probe memory only: never written to config.json, never logged, never put in
// a trace or a result. String / GoString / MarshalJSON mask them so an
// accidental %v or json.Marshal cannot leak them.
type CheckCredentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (c *CheckCredentials) String() string   { return "basic(***)" }
func (c *CheckCredentials) GoString() string { return "basic(***)" }

// MarshalJSON never serialises the secret (decoding keeps the default rules).
func (c CheckCredentials) MarshalJSON() ([]byte, error) { return []byte(`"***"`), nil }

// CheckTarget is ProbeCheckTarget.
type CheckTarget struct {
	RuleID      int               `json:"ruleId"`
	ItemID      int               `json:"itemId"`
	IP          string            `json:"ip"`
	Mac         *string           `json:"mac"`
	Credentials *CheckCredentials `json:"credentials,omitempty"`
	AuthBlocked string            `json:"authBlocked,omitempty"` // missing | no_key | insecure_transport
}

// CheckError is ProbeCheckResult.error.
type CheckError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// TraceStep is DeviceCheckTraceStep.
type TraceStep struct {
	Step   string `json:"step"`
	Status string `json:"status"` // ok | failed | skipped
	Ms     int64  `json:"ms"`
	Detail string `json:"detail,omitempty"`
}

// CheckResult is ProbeCheckResult. Values holds string / float64 / bool / nil;
// Regex holds true / false / nil (nil when the tested field is null).
type CheckResult struct {
	RuleID      int              `json:"ruleId"`
	RuleRev     int              `json:"ruleRev"`
	ItemID      int              `json:"itemId"`
	IP          string           `json:"ip"`
	VariantID   *string          `json:"variantId"`
	StartedAt   string           `json:"startedAt"`
	DurationMs  int64            `json:"durationMs"`
	Status      string           `json:"status"` // ok | error
	Attempts    int              `json:"attempts"`
	HTTPStatus  int              `json:"httpStatus,omitempty"`
	Bytes       int64            `json:"bytes,omitempty"`
	Truncated   bool             `json:"truncated,omitempty"`
	MacCheck    string           `json:"macCheck"` // match | unverified
	Values      map[string]any   `json:"values"`
	Regex       map[string]*bool `json:"regex"`
	Error       *CheckError      `json:"error,omitempty"`
	Trace       []TraceStep      `json:"trace,omitempty"`
	BodySnippet string           `json:"bodySnippet,omitempty"`
}

// ResultsBatch is ProbeCheckResultsBatch (the body of POST
// /api/probe/check-results; the WS check_results message adds "type").
type ResultsBatch struct {
	V       int           `json:"v"`
	SentAt  string        `json:"sentAt"`
	Results []CheckResult `json:"results"`
}

// Error codes (ProbeCheckErrorCode).
const (
	chkErrTimeout          = "timeout"
	chkErrConnRefused      = "conn_refused"
	chkErrUnreachable      = "unreachable"
	chkErrTLS              = "tls"
	chkErrHTTPStatus       = "http_status"
	chkErrMacMismatch      = "mac_mismatch"
	chkErrMacUnverified    = "mac_unverified"
	chkErrTargetNotAllowed = "target_not_allowed"
	chkErrExtractFailed    = "extract_failed"
	chkErrRegexCompile     = "regex_compile"
	chkErrOverrun          = "overrun"
	chkErrCredsUnavailable = "credentials_unavailable"
	chkErrInsecureTransp   = "insecure_transport"
	chkErrPolicyDenied     = "policy_denied"
	chkErrInternal         = "internal"
)

// checkErr is an error carrying a ProbeCheckErrorCode. The message never
// contains credentials or response bodies.
type checkErr struct {
	code string
	msg  string
}

func (e *checkErr) Error() string { return e.code + ": " + e.msg }

func newCheckErr(code, msg string) *checkErr { return &checkErr{code: code, msg: msg} }
