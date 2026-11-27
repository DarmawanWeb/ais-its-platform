{{/* Chart name (the umbrella alias, e.g. "auth"). */}}
{{- define "ais-its-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Resource name; the umbrella sets fullnameOverride to the spec §3 hostname. */}}
{{- define "ais-its-service.fullname" -}}
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

{{- define "ais-its-service.imageTag" -}}
{{- .Values.image.tag | default ((.Values.global).imageTag) | default .Chart.AppVersion }}
{{- end }}

{{/* Image reference; a floating "latest" tag is refused (pin a version or a digest). */}}
{{- define "ais-its-service.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- $tag := include "ais-its-service.imageTag" . }}
{{- if eq $tag "latest" }}
{{- fail (printf "%s: image tag \"latest\" is not allowed; pin image.tag (or global.imageTag) to a release, or set image.digest" .Values.image.repository) }}
{{- end }}
{{- printf "%s:%s" .Values.image.repository $tag }}
{{- end }}
{{- end }}

{{- define "ais-its-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ais-its-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ais-its-service.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "ais-its-service.selectorLabels" . }}
app.kubernetes.io/version: {{ include "ais-its-service.imageTag" . | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/component: {{ include "ais-its-service.name" . }}
app.kubernetes.io/part-of: ais-its
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ais-its-service.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ais-its-service.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Name of the Secret holding this process' own variables ("" = none). */}}
{{- define "ais-its-service.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else if .Values.secretEnv }}
{{- include "ais-its-service.fullname" . }}
{{- end }}
{{- end }}

{{/* Most replicas the Deployment can run: the HPA maximum, else replicaCount. */}}
{{- define "ais-its-service.maxReplicas" -}}
{{- if .Values.autoscaling.enabled }}
{{- .Values.autoscaling.maxReplicas }}
{{- else }}
{{- .Values.replicaCount }}
{{- end }}
{{- end }}

{{/* Container port names are limited to 15 characters. */}}
{{- define "ais-its-service.secondaryPortName" -}}
{{- printf "http-%s" .Values.secondaryContainer.name | trunc 15 | trimSuffix "-" }}
{{- end }}

{{/* Writable emptyDir volume name for a path, e.g. /var/cache/nginx → w-var-cache-nginx. */}}
{{- define "ais-its-service.volumeName" -}}
{{- printf "w-%s" (regexReplaceAll "[^a-z0-9]+" (lower .) "-" | trimAll "-") | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* envFrom shared by every container of the Pod. */}}
{{- define "ais-its-service.envFrom" -}}
- configMapRef:
    name: {{ include "ais-its-service.fullname" . }}
{{- if .Values.platformEnv }}
{{- with (.Values.global).existingSecret }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- end }}
{{- with include "ais-its-service.secretName" . }}
- secretRef:
    name: {{ . }}
{{- end }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Downward-API variables: pod identity for logs and OpenTelemetry resources. */}}
{{- define "ais-its-service.podEnv" -}}
- name: POD_NAME
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- name: POD_NAMESPACE
  valueFrom: { fieldRef: { fieldPath: metadata.namespace } }
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE),service.version={{ include "ais-its-service.imageTag" . }}"
{{- end }}

{{/* HTTP probes on a named port. Usage: include "ais-its-service.probes" (dict "probes" .Values.probes "port" "http") */}}
{{- define "ais-its-service.probes" -}}
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
