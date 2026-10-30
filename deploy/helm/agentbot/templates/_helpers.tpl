{{- define "agentbot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Release-scoped base name; objects append their component (-orchestrator, -web, -worker). */}}
{{- define "agentbot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 50 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 50 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "agentbot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentbot.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Labels of an object; `.component` is orchestrator, web or worker (or omitted for shared objects). */}}
{{- define "agentbot.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "agentbot.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- with .component }}
app.kubernetes.io/component: {{ . }}
{{- end }}
{{- end }}

{{- define "agentbot.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{- define "agentbot.workerImage" -}}
{{- printf "%s:%s" (default .Values.image.repository .Values.worker.image.repository) (default (default .Chart.AppVersion .Values.image.tag) .Values.worker.image.tag) }}
{{- end }}

{{- define "agentbot.secretName" -}}
{{- default (include "agentbot.fullname" .) .Values.secrets.existingSecret }}
{{- end }}

{{- define "agentbot.orchestratorService" -}}
{{- printf "%s-orchestrator" (include "agentbot.fullname" .) }}
{{- end }}

{{- define "agentbot.webService" -}}
{{- printf "%s-web" (include "agentbot.fullname" .) }}
{{- end }}

{{/* The orchestrator's internal API, reachable from other namespaces (the KEDA operator). */}}
{{- define "agentbot.orchestratorUrl" -}}
{{- printf "http://%s.%s.svc:8081" (include "agentbot.orchestratorService" .) .Release.Namespace }}
{{- end }}

{{/* Egress rule: name lookups (port 53, UDP and TCP) at the peers in networkPolicy.dns (F5). */}}
{{- define "agentbot.dnsEgress" -}}
- to:
    {{- toYaml .Values.networkPolicy.dns | nindent 4 }}
  ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
{{- end }}

{{/* Egress rule: the orchestrator's internal API (F5). */}}
{{- define "agentbot.orchestratorEgress" -}}
- to:
    - podSelector:
        matchLabels:
          {{- include "agentbot.selectorLabels" (dict "root" . "component" "orchestrator") | nindent 10 }}
  ports:
    - port: 8081
      protocol: TCP
{{- end }}

{{/*
A secret volume with the given keys of the AgentBot Secret, mounted at /run/secrets like compose's secrets.
Mode 0400; with fsGroup 10001 Kubernetes makes the files root:10001 0440, so only agentbot (and root) can read them.
*/}}
{{- define "agentbot.secretVolume" -}}
- name: secrets
  secret:
    secretName: {{ include "agentbot.secretName" .root }}
    # 0400 in decimal: YAML 1.1 and 1.2 parsers read a leading-zero 0400 differently.
    defaultMode: 256
    items:
      {{- range .keys }}
      - key: {{ . }}
        path: agentbot_{{ . | replace "-" "_" }}
      {{- end }}
{{- end }}

{{/*
Pod settings shared by every AgentBot pod:
- no service account token: nothing in AgentBot talks to the Kubernetes API, and agents must not;
- no service links: Kubernetes would inject <SERVICE>_PORT variables, and a Service named <release>-agentbot-web
  turns into AGENTBOT_WEB_PORT=tcp://..., which collides with AgentBot's own settings;
- a shared process namespace, so that the pause container is PID 1 and reaps orphaned processes (compose's `init: true`).
*/}}
{{- define "agentbot.podSpec" -}}
automountServiceAccountToken: false
enableServiceLinks: false
shareProcessNamespace: true
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
  {{- toYaml .Values.podSecurityContext | nindent 2 }}
{{- end }}

{{- define "agentbot.scheduling" -}}
{{- with .nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/* AGENTBOT_WORKER_DISK from worker.diskLimit: the same binary size in Podman notation (20Gi -> 20g). */}}
{{- define "agentbot.workerDisk" -}}
{{- $limit := toString .Values.worker.diskLimit }}
{{- if not (regexMatch "^[0-9]+(Ki|Mi|Gi|Ti)$" $limit) }}
{{- fail (printf "worker.diskLimit must be a whole number of Ki, Mi, Gi or Ti (e.g. 20Gi), got %q" $limit) }}
{{- end }}
{{- $limit | lower | trimSuffix "i" }}
{{- end }}
