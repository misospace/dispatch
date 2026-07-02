{{/*
Expand the name of the chart.
*/}}
{{- define "dispatch.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "dispatch.fullname" -}}
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

{{/*
Create chart name and version as a valid Kubernetes resource name.
*/}}
{{- define "dispatch.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "dispatch.labels" -}}
helm.sh/chart: {{ include "dispatch.chart" . }}
{{ include "dispatch.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "dispatch.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dispatch.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "dispatch.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "dispatch.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Image tag — defaults to appVersion when not set
*/}}
{{- define "dispatch.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag }}
{{- end }}

{{/*
Render DISPATCH_LANE_CONFIG_JSON from structured lanes config.
*/}}
{{- define "dispatch.laneConfigJson" -}}
{{- $lanes := list -}}
{{- range .Values.config.lanes }}
  {{- $lane := dict "id" .id "title" .title "claimable" .claimable -}}
  {{- if .role -}}
    {{- $_ := set $lane "role" .role -}}
  {{- end -}}
  {{- if .description -}}
    {{- $_ := set $lane "description" .description -}}
  {{- end -}}
  {{- if .color -}}
    {{- $_ := set $lane "color" .color -}}
  {{- end -}}
  {{- if .defaultAgent -}}
    {{- $_ := set $lane "defaultAgent" .defaultAgent -}}
  {{- end -}}
  {{- $lanes = append $lanes $lane -}}
{{- end -}}
{{- $aliases := .Values.config.laneAliases | default dict -}}
{{- $config := dict "lanes" $lanes "laneAliases" $aliases -}}
{{- $config | toJson -}}
{{- end }}
