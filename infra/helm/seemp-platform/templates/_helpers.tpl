{{/* Gateway objects are named after the release (one platform per namespace). */}}
{{- define "seemp-platform.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "seemp-platform.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: seemp
app.kubernetes.io/component: gateway
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Middleware resource name: <release>-<short name>. Usage: include "seemp-platform.middleware" (list $ "compress") */}}
{{- define "seemp-platform.middleware" -}}
{{- printf "%s-%s" (include "seemp-platform.fullname" (index . 0)) (index . 1) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
  Traefik rule of a route: PathPrefix/Path terms joined with ||, scoped to the
  configured hosts. Usage: include "seemp-platform.match" (dict "route" . "hosts" $.Values.gateway.hosts)
*/}}
{{- define "seemp-platform.match" -}}
{{- $terms := list }}
{{- range .route.prefixes }}{{ $terms = append $terms (printf "PathPrefix(`%s`)" .) }}{{ end }}
{{- range .route.paths }}{{ $terms = append $terms (printf "Path(`%s`)" .) }}{{ end }}
{{- $match := join " || " $terms }}
{{- if .hosts }}
{{- $hostTerms := list }}
{{- range .hosts }}{{ $hostTerms = append $hostTerms (printf "Host(`%s`)" .) }}{{ end }}
{{- $match = printf "(%s) && (%s)" (join " || " $hostTerms) $match }}
{{- end }}
{{- $match }}
{{- end }}
