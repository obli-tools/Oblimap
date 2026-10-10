package main

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ─── Device Checks: extractors, transforms, coercion ─────────────────────────
//
// Pure functions: no I/O, no global state. Every rule-supplied regex runs
// under Go's RE2 engine (linear time). JSON and XML use a small path subset
// over the standard library decoders; the XML token stream is capped.

const (
	xmlMaxTokens = 10000
	xmlMaxDepth  = 256
	// chkMaxRawValue bounds a raw extracted value before the transforms (the
	// final value is at most chkMaxValueLen runes).
	chkMaxRawValue = 64 << 10
)

// extractInput is what the extractors of one variant work on. body is the
// decoded (UTF-8) response body.
type extractInput struct {
	body       string
	header     http.Header
	status     int
	durationMs int64

	jsonDone bool
	jsonDoc  any
	jsonErr  error
}

// json returns the decoded JSON document of the body (decoded once).
func (in *extractInput) json() (any, error) {
	if !in.jsonDone {
		in.jsonDone = true
		in.jsonDoc, in.jsonErr = decodeJSONDoc(in.body)
	}
	return in.jsonDoc, in.jsonErr
}

// compiledExtractor is a validated extractor with its regex / path compiled.
type compiledExtractor struct {
	ex       CheckExtractor
	re       *regexp.Regexp
	jsonPath []jsonStep
	xmlPath  xmlPath
}

// compileExtractor compiles the regex or path of e. A regex that RE2 cannot
// compile returns an error reported as regex_compile.
func compileExtractor(e CheckExtractor) (compiledExtractor, error) {
	ce := compiledExtractor{ex: e}
	switch e.Type {
	case "regex":
		re, err := regexp.Compile(e.Pattern)
		if err != nil {
			return ce, err
		}
		if e.Group > re.NumSubexp() {
			return ce, fmt.Errorf("group %d not in pattern (%d groups)", e.Group, re.NumSubexp())
		}
		ce.re = re
	case "json":
		p, err := parseJSONPath(e.Path)
		if err != nil {
			return ce, err
		}
		ce.jsonPath = p
	case "xml":
		p, err := parseXMLPath(e.Path)
		if err != nil {
			return ce, err
		}
		ce.xmlPath = p
	}
	return ce, nil
}

// run applies the extractor. found reports whether the element exists; a
// found element may still have a nil (JSON null) or empty value.
func (ce *compiledExtractor) run(in *extractInput) (val *string, found bool) {
	switch ce.ex.Type {
	case "regex":
		subject := in.body
		if ce.ex.Source == "header" {
			vals := in.header.Values(ce.ex.Header)
			if len(vals) == 0 {
				return nil, false
			}
			subject = strings.Join(vals, ", ")
		}
		return extractRegex(ce.re, ce.ex.Group, subject)
	case "json":
		doc, err := in.json()
		if err != nil {
			return nil, false
		}
		return extractJSON(doc, ce.jsonPath)
	case "xml":
		return extractXML(in.body, ce.xmlPath)
	case "httpStatus":
		if in.status == 0 {
			return nil, false
		}
		s := strconv.Itoa(in.status)
		return &s, true
	case "durationMs":
		s := strconv.FormatInt(in.durationMs, 10)
		return &s, true
	}
	return nil, false
}

// ─── Regex ───────────────────────────────────────────────────────────────────

// extractRegex returns capture group `group` (0 = whole match) of the first
// match. A group that did not participate in the match yields "".
func extractRegex(re *regexp.Regexp, group int, subject string) (*string, bool) {
	if re == nil {
		return nil, false
	}
	idx := re.FindStringSubmatchIndex(subject)
	if idx == nil || 2*group+1 >= len(idx) {
		return nil, false
	}
	s := ""
	if idx[2*group] >= 0 {
		s = capString(subject[idx[2*group]:idx[2*group+1]], chkMaxRawValue)
	}
	return &s, true
}

// ─── JSON path subset: a.b[0].c ──────────────────────────────────────────────

type jsonStep struct {
	key   string
	index int
	isIdx bool
}

// parseJSONPath parses the subset `name(\[n\])*(\.name(\[n\])*)*` where name
// is [A-Za-z_][\w-]{0,63} and n has at most 4 digits (at most 12 names). A
// leading index ("[0].a") addresses a root array.
func parseJSONPath(p string) ([]jsonStep, error) {
	if p == "" || len(p) > chkMaxPathLen {
		return nil, fmt.Errorf("invalid JSON path")
	}
	var steps []jsonStep
	names := 0
	i := 0
	expectName := p[0] != '['
	for i < len(p) {
		if expectName {
			start := i
			for i < len(p) && isJSONNameChar(p[i], i == start) {
				i++
			}
			if i == start || i-start > 64 {
				return nil, fmt.Errorf("invalid JSON path")
			}
			steps = append(steps, jsonStep{key: p[start:i]})
			names++
			if names > 12 {
				return nil, fmt.Errorf("JSON path has more than 12 segments")
			}
			expectName = false
			continue
		}
		switch p[i] {
		case '[':
			j := i + 1
			for j < len(p) && p[j] >= '0' && p[j] <= '9' {
				j++
			}
			if j == i+1 || j-(i+1) > 4 || j >= len(p) || p[j] != ']' {
				return nil, fmt.Errorf("invalid JSON path index")
			}
			n, _ := strconv.Atoi(p[i+1 : j])
			steps = append(steps, jsonStep{index: n, isIdx: true})
			i = j + 1
		case '.':
			if i+1 >= len(p) {
				return nil, fmt.Errorf("invalid JSON path")
			}
			i++
			expectName = true
		default:
			return nil, fmt.Errorf("invalid JSON path")
		}
	}
	if expectName || len(steps) == 0 || len(steps) > 64 {
		return nil, fmt.Errorf("invalid JSON path")
	}
	return steps, nil
}

func isJSONNameChar(c byte, first bool) bool {
	switch {
	case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c == '_':
		return true
	case c >= '0' && c <= '9', c == '-':
		return !first
	}
	return false
}

// decodeJSONDoc decodes the first JSON value of body (numbers kept verbatim).
func decodeJSONDoc(body string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(strings.TrimPrefix(body, "\xef\xbb\xbf")))
	dec.UseNumber()
	var doc any
	if err := dec.Decode(&doc); err != nil {
		return nil, err
	}
	return doc, nil
}

// extractJSON walks doc along steps. Scalars are returned as text (numbers
// verbatim, booleans as true/false), null as a found nil value, objects and
// arrays as compact JSON.
func extractJSON(doc any, steps []jsonStep) (*string, bool) {
	cur := doc
	for _, st := range steps {
		if st.isIdx {
			arr, ok := cur.([]any)
			if !ok || st.index >= len(arr) {
				return nil, false
			}
			cur = arr[st.index]
			continue
		}
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		next, ok := obj[st.key]
		if !ok {
			return nil, false
		}
		cur = next
	}
	var s string
	switch v := cur.(type) {
	case nil:
		return nil, true
	case string:
		s = v
	case json.Number:
		s = v.String()
	case bool:
		s = strconv.FormatBool(v)
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil, false
		}
		s = string(b)
	}
	s = capString(s, chkMaxRawValue)
	return &s, true
}

// extractJSONBody decodes body and extracts path (used by tests and fuzzing).
func extractJSONBody(body, path string) (*string, bool) {
	steps, err := parseJSONPath(path)
	if err != nil {
		return nil, false
	}
	doc, err := decodeJSONDoc(body)
	if err != nil {
		return nil, false
	}
	return extractJSON(doc, steps)
}

// ─── XML path subset: /a/b/c and /a/b/@attr ──────────────────────────────────

type xmlPath struct {
	elems []string
	attr  string
}

var xmlPathRe = regexp.MustCompile(`^(/[A-Za-z_][\w.-]{0,63}){1,12}(/@[A-Za-z_][\w.-]{0,63})?$`)

// parseXMLPath parses an absolute path of local element names, optionally
// ending with /@attribute.
func parseXMLPath(p string) (xmlPath, error) {
	if len(p) > chkMaxPathLen || !xmlPathRe.MatchString(p) {
		return xmlPath{}, fmt.Errorf("invalid XML path")
	}
	var xp xmlPath
	for _, part := range strings.Split(p[1:], "/") {
		if strings.HasPrefix(part, "@") {
			xp.attr = part[1:]
			continue
		}
		xp.elems = append(xp.elems, part)
	}
	return xp, nil
}

// extractXML returns the text content (all descendant character data) of the
// first element matching path, or the value of its attribute. Namespace
// prefixes are ignored (local names). The decoder is lenient (HTML entities,
// auto-closed tags, any declared encoding: body is already UTF-8) and reads at
// most xmlMaxTokens tokens.
func extractXML(body string, path xmlPath) (*string, bool) {
	if len(path.elems) == 0 {
		return nil, false
	}
	d := xml.NewDecoder(strings.NewReader(strings.TrimPrefix(body, "\xef\xbb\xbf")))
	d.Strict = false
	d.AutoClose = xml.HTMLAutoClose
	d.Entity = xml.HTMLEntity
	d.CharsetReader = func(_ string, r io.Reader) (io.Reader, error) { return r, nil }

	var stack []string
	collectDepth := 0 // > 0 while collecting the text of the matched element
	var sb strings.Builder

	for n := 0; n < xmlMaxTokens; n++ {
		tok, err := d.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if len(stack) >= xmlMaxDepth {
				return nil, false
			}
			stack = append(stack, t.Name.Local)
			if collectDepth > 0 || !xmlStackMatches(stack, path.elems) {
				continue
			}
			if path.attr != "" {
				for _, a := range t.Attr {
					if a.Name.Local == path.attr {
						s := capString(a.Value, chkMaxRawValue)
						return &s, true
					}
				}
				continue
			}
			collectDepth = len(stack)
		case xml.EndElement:
			if collectDepth > 0 && len(stack) == collectDepth {
				s := sb.String()
				return &s, true
			}
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case xml.CharData:
			if collectDepth > 0 && sb.Len() < chkMaxRawValue {
				sb.Write(t)
			}
		}
	}
	if collectDepth > 0 {
		// The element was found but the document ended (or the token cap was
		// reached) before it closed: keep what was read.
		s := capString(sb.String(), chkMaxRawValue)
		return &s, true
	}
	return nil, false
}

func xmlStackMatches(stack, elems []string) bool {
	if len(stack) != len(elems) {
		return false
	}
	for i := range elems {
		if stack[i] != elems[i] {
			return false
		}
	}
	return true
}

// extractXMLBody parses path and extracts it from body (tests and fuzzing).
func extractXMLBody(body, path string) (*string, bool) {
	xp, err := parseXMLPath(path)
	if err != nil {
		return nil, false
	}
	return extractXML(body, xp)
}

// ─── Transforms ──────────────────────────────────────────────────────────────

var numberInTextRe = regexp.MustCompile(`[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)`)

// applyTransforms runs the transforms in order. A nil value (element not
// found, or JSON null) is only affected by "default".
func applyTransforms(v *string, ts []CheckTransform) *string {
	for _, t := range ts {
		if v == nil {
			if t.Op == "default" && t.Value != nil {
				s := *t.Value
				v = &s
			}
			continue
		}
		s := *v
		switch t.Op {
		case "trim":
			s = strings.TrimFunc(s, unicode.IsSpace)
		case "collapseSpaces":
			s = collapseSpaces(s)
		case "htmlUnescape":
			s = html.UnescapeString(s)
		case "stripTags":
			s = stripTags(s)
		case "lowercase":
			s = strings.ToLower(s)
		case "uppercase":
			s = strings.ToUpper(s)
		case "toNumber":
			n, ok := toNumberString(s)
			if !ok {
				v = nil
				continue
			}
			s = n
		case "map":
			if mapped, ok := t.Values[s]; ok {
				s = mapped
			} else if t.Default != nil {
				s = *t.Default
			}
		case "truncate":
			s = truncateRunes(s, t.Max)
		case "default":
			if s == "" && t.Value != nil {
				s = *t.Value
			}
		}
		s = capString(s, chkMaxRawValue)
		v = &s
	}
	return v
}

// collapseSpaces replaces every run of Unicode white space (including
// non-breaking spaces and line breaks) with one ASCII space.
func collapseSpaces(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
			}
			inSpace = true
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	return b.String()
}

// stripTags removes everything between '<' and the next '>'.
func stripTags(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inTag := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '<':
			inTag = true
		case c == '>' && inTag:
			inTag = false
		case !inTag:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// toNumberString extracts the first number of s ("75", "-3.5", "12,5" with a
// decimal comma) and returns it in canonical form.
func toNumberString(s string) (string, bool) {
	m := numberInTextRe.FindString(s)
	if m == "" {
		return "", false
	}
	f, err := strconv.ParseFloat(strings.Replace(m, ",", ".", 1), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return "", false
	}
	return strconv.FormatFloat(f, 'g', -1, 64), true
}

// ─── Coercion ────────────────────────────────────────────────────────────────

// coerceValue converts a transformed value to the field's declared type:
// string / enum → control characters removed and truncated to maxLength
// runes (≤ 256); enum → must be one of enumValues when the rule lists them;
// number → finite float64; boolean → true/false. Anything else is nil (null).
func coerceValue(f *CheckField, v *string) any {
	if v == nil {
		return nil
	}
	switch f.ValueType {
	case "number":
		s := strings.TrimFunc(*v, unicode.IsSpace)
		if !strings.Contains(s, ".") {
			s = strings.Replace(s, ",", ".", 1)
		}
		n, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return nil
		}
		return n
	case "boolean":
		switch strings.ToLower(strings.TrimFunc(*v, unicode.IsSpace)) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		}
		return nil
	default: // string, enum
		max := f.MaxLength
		if max <= 0 || max > chkMaxValueLen {
			max = chkMaxValueLen
		}
		s := truncateRunes(stripControls(*v), max)
		if f.ValueType == "enum" && len(f.EnumValues) > 0 {
			for _, ev := range f.EnumValues {
				if ev.Value == s {
					return s
				}
			}
			return nil
		}
		return s
	}
}

// regexTestSubject renders a coerced value for a regex test.
func regexTestSubject(v any) (string, bool) {
	switch x := v.(type) {
	case nil:
		return "", false
	case string:
		return x, true
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(x), true
	}
	return "", false
}

// stripControls turns tabs and line breaks into spaces, removes every other
// control character and replaces invalid UTF-8.
func stripControls(s string) string {
	s = strings.ToValidUTF8(s, string(utf8.RuneError))
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\t' || r == '\n' || r == '\r':
			b.WriteByte(' ')
		case unicode.IsControl(r):
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// truncateRunes keeps at most max runes of s.
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i]
		}
		n++
	}
	return s
}

// capString keeps at most max bytes of s, cut on a rune boundary.
func capString(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
