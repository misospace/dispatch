---
{{- include "bjw-s.common.loader.init" . }}

{{- /*
  The common library rejects an empty image tag with no digest. The chart
  keeps tag "" in values.yaml (the release workflow stamps appVersion), so
  default the tag to the chart appVersion at render time when neither tag
  nor digest is set.
*/}}
{{- $img := .Values.controllers.main.containers.main.image }}
{{- if and (not $img.tag) (not $img.digest) }}
{{- $_ := set $img "tag" .Chart.AppVersion }}
{{- end }}

{{- include "bjw-s.common.loader.generate" . }}
