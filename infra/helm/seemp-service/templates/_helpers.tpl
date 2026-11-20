{{/* Chart name (the umbrella alias, e.g. "auth"). */}}
{{- define "seemp-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Resource name; the umbrella sets fullnameOverride to the spec §3 hostname. */}}
{{- define "seemp-service.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "seemp-service.imageTag" -}}
{{- .Values.image.tag | default ((.Values.global).imageTag) | default .Chart.AppVersion }}
{{- end }}

{{- define "seemp-service.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (include "seemp-service.imageTag" .) }}
{{- end }}
{{- end }}

{{- define "seemp-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "seemp-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "seemp-service.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "seemp-service.selectorLabels" . }}
app.kubernetes.io/version: {{ include "seemp-service.imageTag" . | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/component: {{ include "seemp-service.name" . }}
app.kubernetes.io/part-of: seemp
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "seemp-service.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "seemp-service.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Name of the Secret holding this process' own variables ("" = none). */}}
{{- define "seemp-service.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else if .Values.secretEnv }}
{{- include "seemp-service.fullname" . }}
{{- end }}
{{- end }}

{{/* Container port names are limited to 15 characters. */}}
{{- define "seemp-service.secondaryPortName" -}}
{{- printf "http-%s" .Values.secondaryContainer.name | trunc 15 | trimSuffix "-" }}
{{- end }}

{{/* Writable emptyDir volume name for a path, e.g. /var/cache/nginx → w-var-cache-nginx. */}}
{{- define "seemp-service.volumeName" -}}
{{- printf "w-%s" (regexReplaceAll "[^a-z0-9]+" (lower .) "-" | trimAll "-") | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* envFrom shared by every container of the Pod. */}}
{{- define "seemp-service.envFrom" -}}
- configMapRef:
    name: {{ include "seemp-service.fullname" . }}
{{- if .Values.platformEnv }}
{{- with (.Values.global).existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end }}
{{- with include "seemp-service.secretName" . }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Downward-API variables: pod identity for logs and OpenTelemetry resources. */}}
{{- define "seemp-service.podEnv" -}}
- name: POD_NAME
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- name: POD_NAMESPACE
  valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE),service.version={{ include "seemp-service.imageTag" . }}"
{{- end }}

{{/* HTTP probes on a named port. Usage: include "seemp-service.probes" (dict "probes" .Values.probes "port" "http") */}}
{{- define "seemp-service.probes" -}}
{{- with .probes.startup }}
{{- if .enabled }}
startupProbe:
  httpGet: { path: {{ .path }}, port: {{ $.port }} }
  periodSeconds: {{ .periodSeconds }}
  timeoutSeconds: {{ .timeoutSeconds }}
  failureThreshold: {{ .failureThreshold }}
{{- end }}
{{- end }}
{{- with .probes.liveness }}
{{- if .enabled }}
livenessProbe:
  httpGet: { path: {{ .path }}, port: {{ $.port }} }
  periodSeconds: {{ .periodSeconds }}
  timeoutSeconds: {{ .timeoutSeconds }}
  failureThreshold: {{ .failureThreshold }}
{{- end }}
{{- end }}
{{- with .probes.readiness }}
{{- if .enabled }}
readinessProbe:
  httpGet: { path: {{ .path }}, port: {{ $.port }} }
  periodSeconds: {{ .periodSeconds }}
  timeoutSeconds: {{ .timeoutSeconds }}
  failureThreshold: {{ .failureThreshold }}
{{- end }}
{{- end }}
{{- end }}
