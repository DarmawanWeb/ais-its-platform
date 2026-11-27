{{/* Gateway objects are named after the release (one platform per namespace). */}}
{{- define "ais-its-platform.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ais-its-platform.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: ais-its
app.kubernetes.io/component: gateway
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Middleware resource name: <release>-<short name>. Usage: include "ais-its-platform.middleware" (list $ "compress") */}}
{{- define "ais-its-platform.middleware" -}}
{{- printf "%s-%s" (include "ais-its-platform.fullname" (index . 0)) (index . 1) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
  Traefik rule of a route: PathPrefix/Path terms joined with ||, scoped to the
  configured hosts. Usage: include "ais-its-platform.match" (dict "route" . "hosts" $.Values.gateway.hosts)
*/}}
{{- define "ais-its-platform.match" -}}
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

{{/*
  ais-pipeline README (Operations, "Scaling"): every ingestor connects to each
  upstream whose URL is set, with the same AIS_UPSTREAM_TOKEN, so run one per
  upstream account. The replicas of one Deployment share their environment, so a
  feed URL in env or secretEnv allows one replica (HPA off). URLs supplied through
  existingSecret or extraEnvFrom are not visible here.
*/}}
{{- define "ais-its-platform.checkIngestorFeeds" -}}
{{- $c := index .Values "ais-ingestor" | default dict }}
{{- if $c.enabled }}
{{- $env := $c.env | default dict }}
{{- $secretEnv := $c.secretEnv | default dict }}
{{- $feeds := list }}
{{- range $key := list "AIS_PRIMARY_URL" "AIS_BATAM_URL" }}
{{- if index $env $key | default (index $secretEnv $key) | default "" | toString | trim }}
{{- $feeds = append $feeds $key }}
{{- end }}
{{- end }}
{{- $autoscaling := $c.autoscaling | default dict }}
{{- $max := int ($c.replicaCount | default 1) }}
{{- if $autoscaling.enabled }}
{{- $max = int ($autoscaling.maxReplicas | default 2) }}
{{- end }}
{{- if and $feeds (gt $max 1) }}
{{- fail (printf "ais-ingestor: %s set with up to %d replicas. Every replica connects to each upstream whose URL is set, with the same AIS_UPSTREAM_TOKEN (ais-pipeline README, Operations: Scaling): set ais-ingestor.replicaCount to 1 with autoscaling disabled, or leave the feed URLs empty." (join " and " $feeds) $max) }}
{{- end }}
{{- end }}
{{- end }}
