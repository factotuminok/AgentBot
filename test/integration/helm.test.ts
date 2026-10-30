import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The Helm chart (architecture §7.3, requirements OPS-07, OPS-08): `helm lint` and `helm template` with the defaults and
 * the main toggles, asserting the rendered objects. Needs helm: `.tools/helm`, `$HELM` or `helm` on the PATH.
 */

const ROOT = join(import.meta.dir, "..", "..");
const CHART = join(ROOT, "deploy", "helm", "agentbot");
const KEDA_API = "keda.sh/v1alpha1/ScaledJob";
const HELM = process.env.HELM ?? (existsSync(join(ROOT, ".tools", "helm")) ? join(ROOT, ".tools", "helm") : Bun.which("helm"));

if (!HELM) console.warn("helm.test.ts skipped: no helm binary (download one to .tools/helm, set HELM or put helm on the PATH)");

interface EnvVar {
	name: string;
	value?: string;
}
interface Probe {
	httpGet?: { path: string; port: string };
	exec?: { command: string[] };
	periodSeconds?: number;
	failureThreshold?: number;
}
interface Container {
	name: string;
	image: string;
	command?: string[];
	args: string[];
	env: EnvVar[];
	ports?: { name: string; containerPort: number }[];
	readinessProbe: Probe;
	livenessProbe: Probe;
	securityContext: { allowPrivilegeEscalation: boolean; capabilities: { drop: string[] } };
	resources: { requests: Record<string, string>; limits: Record<string, string> };
	volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
}
interface Volume {
	name: string;
	persistentVolumeClaim?: { claimName: string };
	emptyDir?: { medium?: string; sizeLimit?: string };
	secret?: { secretName: string; defaultMode: number; items: { key: string; path: string }[] };
}
interface PodSpec {
	restartPolicy?: string;
	terminationGracePeriodSeconds?: number;
	automountServiceAccountToken: boolean;
	enableServiceLinks: boolean;
	nodeSelector?: Record<string, string>;
	securityContext: { runAsUser: number; runAsGroup: number; fsGroup: number; runAsNonRoot: boolean };
	containers: Container[];
	volumes: Volume[];
}
interface PodTemplate {
	metadata: { labels: Record<string, string> };
	spec: PodSpec;
}
interface PeerSelector {
	podSelector?: { matchLabels: Record<string, string> };
	namespaceSelector?: { matchLabels: Record<string, string> };
	ipBlock?: { cidr: string; except?: string[] };
}
interface Spec {
	replicas?: number;
	strategy?: { type: string };
	template?: PodTemplate;
	type?: string;
	ports?: { port: number }[];
	// ScaledJob
	pollingInterval?: number;
	minReplicaCount?: number;
	maxReplicaCount?: number;
	successfulJobsHistoryLimit?: number;
	scalingStrategy?: { strategy: string; pendingPodConditions: string[] };
	triggers?: { type: string; metadata: Record<string, string>; authenticationRef: { name: string } }[];
	jobTargetRef?: { backoffLimit: number; ttlSecondsAfterFinished: number; activeDeadlineSeconds?: number; template: PodTemplate };
	// TriggerAuthentication
	secretTargetRef?: { parameter: string; name: string; key: string }[];
	// NetworkPolicy
	podSelector?: { matchLabels: Record<string, string> };
	policyTypes?: string[];
	ingress?: { from?: PeerSelector[]; ports?: { port: number; protocol: string }[] }[];
	egress?: { to?: PeerSelector[]; ports?: { port: number; protocol: string }[] }[];
	// Ingress
	tls?: { hosts: string[]; secretName?: string }[];
	rules?: { host: string }[];
	// PersistentVolumeClaim
	accessModes?: string[];
}
interface K8sObject {
	apiVersion: string;
	kind: string;
	metadata: { name: string; labels: Record<string, string>; annotations?: Record<string, string> };
	spec: Spec;
	data?: Record<string, string>;
}

function helm(args: string[]): { code: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync([HELM ?? "helm", ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** `helm template agentbot` in namespace agentbot, with the KEDA API present unless `args` say otherwise. */
function render(...args: string[]): K8sObject[] {
	const out = helm(["template", "agentbot", CHART, "--namespace", "agentbot", "--api-versions", KEDA_API, ...args]);
	if (out.code !== 0) throw new Error(`helm template failed: ${out.stderr}`);
	const docs: unknown[] = Bun.YAML.parse(out.stdout) as unknown[];
	return docs.filter((d): d is K8sObject => d !== null && typeof d === "object");
}

function find(objects: K8sObject[], kind: string, name: string): K8sObject {
	const found = objects.find(o => o.kind === kind && o.metadata.name === name);
	if (!found) throw new Error(`no ${kind} ${name} in ${objects.map(o => `${o.kind}/${o.metadata.name}`).join(", ")}`);
	return found;
}

function podSpec(obj: K8sObject): PodSpec {
	const template = obj.spec.template ?? obj.spec.jobTargetRef?.template;
	if (!template) throw new Error(`${obj.kind} ${obj.metadata.name} has no pod template`);
	return template.spec;
}

function env(container: Container): Record<string, string | undefined> {
	return Object.fromEntries(container.env.map(e => [e.name, e.value]));
}

function mounts(container: Container): Record<string, string> {
	return Object.fromEntries(container.volumeMounts.map(m => [m.mountPath, m.name]));
}

function secretVolume(spec: PodSpec): NonNullable<Volume["secret"]> {
	const secret = spec.volumes.find(v => v.name === "secrets")?.secret;
	if (!secret) throw new Error("no secrets volume");
	return secret;
}

function expectHardened(spec: PodSpec): void {
	expect(spec.securityContext).toMatchObject({ runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, runAsNonRoot: true });
	expect(spec.automountServiceAccountToken).toBe(false);
	expect(spec.enableServiceLinks).toBe(false);
	for (const c of spec.containers) {
		expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
		expect(c.securityContext.capabilities.drop).toEqual(["ALL"]);
		// The image's ENTRYPOINT (`agentbot`) stays; the role is the argument.
		expect(c.command).toBeUndefined();
	}
}

const selector = (component: string) => ({
	"app.kubernetes.io/name": "agentbot",
	"app.kubernetes.io/instance": "agentbot",
	"app.kubernetes.io/component": component,
});

/** Egress rules shared by web and workers (F5): kube-dns on port 53, and the orchestrator's 8081. */
const DNS_EGRESS = {
	to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
	ports: [
		{ port: 53, protocol: "UDP" },
		{ port: 53, protocol: "TCP" },
	],
};
const ORCHESTRATOR_EGRESS = { to: [{ podSelector: { matchLabels: selector("orchestrator") } }], ports: [{ port: 8081, protocol: "TCP" }] };

describe.skipIf(!HELM)("helm chart", () => {
	test("helm lint --strict passes", () => {
		const out = helm(["lint", CHART, "--strict"]);
		expect(out.stderr + out.stdout).toContain("0 chart(s) failed");
		expect(out.code).toBe(0);
	});

	test("default values render every §7.3 object", () => {
		const names = render()
			.map(o => `${o.kind}/${o.metadata.name}`)
			.sort();
		expect(names).toEqual([
			"Deployment/agentbot-orchestrator",
			"Deployment/agentbot-web",
			"NetworkPolicy/agentbot-orchestrator",
			"NetworkPolicy/agentbot-web",
			"NetworkPolicy/agentbot-worker",
			"PersistentVolumeClaim/agentbot-state",
			"PersistentVolumeClaim/agentbot-web-home",
			"ScaledJob/agentbot-worker",
			"Secret/agentbot",
			"Service/agentbot-orchestrator",
			"Service/agentbot-web",
			"TriggerAuthentication/agentbot-scale",
		]);
	});

	test("orchestrator: singleton, probes on 8081, capacity, state volume, all four secrets", () => {
		const objects = render();
		const deploy = find(objects, "Deployment", "agentbot-orchestrator");
		expect(deploy.spec.replicas).toBe(1);
		expect(deploy.spec.strategy).toEqual({ type: "Recreate" });
		const spec = podSpec(deploy);
		expectHardened(spec);
		const [c] = spec.containers;
		expect(c.args).toEqual(["orchestrator"]);
		expect(c.ports).toEqual([{ name: "internal", containerPort: 8081 }]);
		expect(c.readinessProbe.httpGet).toEqual({ path: "/readyz", port: "internal" });
		expect(c.livenessProbe.httpGet).toEqual({ path: "/livez", port: "internal" });
		expect(env(c)).toEqual({
			AGENTBOT_MASTER_KEY_FILE: "/run/secrets/agentbot_master_key",
			AGENTBOT_WEB_API_TOKEN_FILE: "/run/secrets/agentbot_web_api_token",
			AGENTBOT_WORKER_TOKEN_FILE: "/run/secrets/agentbot_worker_token",
			AGENTBOT_SCALE_TOKEN_FILE: "/run/secrets/agentbot_scale_token",
			AGENTBOT_WORKER_CAPACITY: "10",
			AGENTBOT_WORKER_DISK: "20g",
		});
		expect(c.resources).toEqual({ requests: { cpu: "250m", memory: "512Mi" }, limits: { memory: "1Gi" } });
		expect(mounts(c)).toEqual({ "/state": "state", "/run/secrets": "secrets" });
		expect(spec.volumes.find(v => v.name === "state")?.persistentVolumeClaim).toEqual({ claimName: "agentbot-state" });
		const secret = secretVolume(spec);
		expect(secret.secretName).toBe("agentbot");
		expect(secret.defaultMode).toBe(0o400);
		expect(secret.items.map(i => i.key)).toEqual(["master-key", "web-api-token", "worker-token", "scale-token"]);
		const svc = find(objects, "Service", "agentbot-orchestrator");
		expect(svc.spec.type).toBe("ClusterIP");
		expect(svc.spec.ports?.map(p => p.port)).toEqual([8081]);
		expect(find(objects, "PersistentVolumeClaim", "agentbot-state").spec.accessModes).toEqual(["ReadWriteOnce"]);
	});

	test("web: /healthz probes, home volume, only the web token, no Ingress by default", () => {
		const objects = render();
		const deploy = find(objects, "Deployment", "agentbot-web");
		expect(deploy.spec.replicas).toBe(1);
		const spec = podSpec(deploy);
		expectHardened(spec);
		const [c] = spec.containers;
		expect(c.args).toEqual(["web"]);
		expect(c.readinessProbe.httpGet).toEqual({ path: "/healthz", port: "http" });
		expect(c.livenessProbe.httpGet).toEqual({ path: "/healthz", port: "http" });
		expect(env(c)).toEqual({
			AGENTBOT_WEB_API_TOKEN_FILE: "/run/secrets/agentbot_web_api_token",
			AGENTBOT_ORCHESTRATOR_URL: "http://agentbot-orchestrator.agentbot.svc:8081",
			AGENTBOT_WEB_VSCODE: "on",
		});
		expect(c.resources).toEqual({ requests: { cpu: "100m", memory: "768Mi" }, limits: { memory: "2Gi" } });
		expect(mounts(c)).toEqual({ "/home/agentbot": "home", "/run/secrets": "secrets" });
		expect(secretVolume(spec).items.map(i => i.key)).toEqual(["web-api-token"]);
		expect(find(objects, "Service", "agentbot-web").spec.ports?.map(p => p.port)).toEqual([8080]);
		expect(objects.some(o => o.kind === "Ingress")).toBe(false);
	});

	test("worker: the S5 ScaledJob with bearer auth, claim readiness and both emptyDirs", () => {
		const objects = render();
		const job = find(objects, "ScaledJob", "agentbot-worker");
		expect(job.apiVersion).toBe("keda.sh/v1alpha1");
		expect(job.spec).toMatchObject({
			pollingInterval: 5,
			minReplicaCount: 0,
			maxReplicaCount: 10,
			scalingStrategy: { strategy: "accurate", pendingPodConditions: ["Ready"] },
			jobTargetRef: { backoffLimit: 0, ttlSecondsAfterFinished: 60 },
		});
		expect(job.spec.successfulJobsHistoryLimit).toBeUndefined();
		expect(job.spec.jobTargetRef?.activeDeadlineSeconds).toBeUndefined();
		expect(job.spec.triggers).toEqual([
			{
				type: "metrics-api",
				metadata: {
					url: "http://agentbot-orchestrator.agentbot.svc:8081/internal/scale",
					format: "json",
					valueLocation: "pendingRuns",
					targetValue: "1",
					authMode: "bearer",
				},
				authenticationRef: { name: "agentbot-scale" },
			},
		]);
		expect(find(objects, "TriggerAuthentication", "agentbot-scale").spec.secretTargetRef).toEqual([
			{ parameter: "token", name: "agentbot", key: "scale-token" },
		]);
		expect(job.spec.jobTargetRef?.template.metadata.labels).toMatchObject(selector("worker"));
		const spec = podSpec(job);
		expect(spec.restartPolicy).toBe("Never");
		expect(spec.terminationGracePeriodSeconds).toBe(60);
		expectHardened(spec);
		const [c] = spec.containers;
		expect(c.args).toEqual(["worker"]);
		expect(c.image).toBe("ghcr.io/factotuminok/agentbot:0.1.0");
		expect(c.readinessProbe).toMatchObject({ exec: { command: ["agentbot", "health", "--claimed"] }, periodSeconds: 1, failureThreshold: 1 });
		expect(c.livenessProbe.exec).toEqual({ command: ["agentbot", "health"] });
		expect(env(c)).toEqual({
			AGENTBOT_ORCHESTRATOR_URL: "http://agentbot-orchestrator.agentbot.svc:8081",
			AGENTBOT_WORKER_TOKEN_FILE: "/run/secrets/agentbot_worker_token",
			AGENTBOT_WORKER_DISK: "20g",
		});
		expect(c.resources).toEqual({
			requests: { cpu: "500m", memory: "1536Mi", "ephemeral-storage": "20Gi" },
			limits: { memory: "4Gi" },
		});
		expect(mounts(c)).toEqual({ "/tmp": "checkout", "/run/agentbot": "run-local", "/run/secrets": "secrets" });
		expect(spec.volumes.find(v => v.name === "checkout")?.emptyDir).toEqual({ sizeLimit: "20Gi" });
		expect(spec.volumes.find(v => v.name === "run-local")?.emptyDir).toEqual({ medium: "Memory", sizeLimit: "256Mi" });
		expect(secretVolume(spec).items.map(i => i.key)).toEqual(["worker-token"]);
	});

	test("generated secrets: four random 64-character values, kept on uninstall", () => {
		const secret = find(render(), "Secret", "agentbot");
		expect(secret.metadata.annotations?.["helm.sh/resource-policy"]).toBe("keep");
		const data = secret.data ?? {};
		expect(Object.keys(data).sort()).toEqual(["master-key", "scale-token", "web-api-token", "worker-token"]);
		const values = Object.values(data).map(v => Buffer.from(v, "base64").toString());
		for (const v of values) expect(v).toMatch(/^[A-Za-z0-9]{64}$/);
		expect(new Set(values).size).toBe(4);
	});

	test("NetworkPolicies follow SEC-15", () => {
		const objects = render();
		const orch = find(objects, "NetworkPolicy", "agentbot-orchestrator");
		expect(orch.spec.podSelector?.matchLabels).toEqual(selector("orchestrator"));
		expect(orch.spec.policyTypes).toEqual(["Ingress"]);
		expect(orch.spec.ingress).toEqual([
			{
				from: [
					{ podSelector: { matchLabels: selector("web") } },
					{ podSelector: { matchLabels: selector("worker") } },
					{
						namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "keda" } },
						podSelector: { matchLabels: { app: "keda-operator" } },
					},
				],
				ports: [{ port: 8081, protocol: "TCP" }],
			},
		]);
		// Only the ingress controller reaches web, so workers cannot. Web itself reaches only DNS and the orchestrator (F5).
		const web = find(objects, "NetworkPolicy", "agentbot-web");
		expect(web.spec.podSelector?.matchLabels).toEqual(selector("web"));
		expect(web.spec.policyTypes).toEqual(["Ingress", "Egress"]);
		expect(web.spec.ingress).toEqual([
			{
				ports: [{ port: 8080, protocol: "TCP" }],
				from: [
					{
						namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" } },
						podSelector: { matchLabels: { "app.kubernetes.io/name": "ingress-nginx" } },
					},
				],
			},
		]);
		expect(web.spec.egress).toEqual([DNS_EGRESS, ORCHESTRATOR_EGRESS]);
		// Workers: no ingress; egress to DNS, the orchestrator and the internet, but not to cloud metadata (link-local)
		// or private ranges, which hold the cluster's pods and Services (F5).
		const worker = find(objects, "NetworkPolicy", "agentbot-worker");
		expect(worker.spec.podSelector?.matchLabels).toEqual(selector("worker"));
		expect(worker.spec.policyTypes).toEqual(["Ingress", "Egress"]);
		expect(worker.spec.ingress).toEqual([]);
		expect(worker.spec.egress).toEqual([
			DNS_EGRESS,
			ORCHESTRATOR_EGRESS,
			{
				to: [
					{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"] } },
					{ ipBlock: { cidr: "::/0", except: ["fd00:ec2::254/128", "fc00::/7"] } },
				],
			},
		]);
		// The orchestrator's egress stays open (Discord, GitHub, npm, sign-in endpoints).
		expect(orch.spec.egress).toBeUndefined();
	});

	test("worker cluster CIDRs and the DNS peers are configurable; link-local stays blocked (F5)", () => {
		const objects = render(
			"--set-json",
			'networkPolicy.worker.clusterCIDRs=["10.244.0.0/16","10.96.0.0/12","fd00:10:244::/56"]',
			"--set-json",
			'networkPolicy.dns=[{"ipBlock":{"cidr":"169.254.20.10/32"}}]',
		);
		const dns = { to: [{ ipBlock: { cidr: "169.254.20.10/32" } }], ports: DNS_EGRESS.ports };
		expect(find(objects, "NetworkPolicy", "agentbot-web").spec.egress).toEqual([dns, ORCHESTRATOR_EGRESS]);
		expect(find(objects, "NetworkPolicy", "agentbot-worker").spec.egress).toEqual([
			dns,
			ORCHESTRATOR_EGRESS,
			{
				to: [
					{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16", "10.244.0.0/16", "10.96.0.0/12"] } },
					{ ipBlock: { cidr: "::/0", except: ["fd00:ec2::254/128", "fd00:10:244::/56"] } },
				],
			},
		]);
		// Even with no cluster ranges, cloud metadata stays out of reach.
		const open = find(render("--set-json", "networkPolicy.worker.clusterCIDRs=[]"), "NetworkPolicy", "agentbot-worker");
		expect(open.spec.egress?.[2]?.to).toEqual([
			{ ipBlock: { cidr: "0.0.0.0/0", except: ["169.254.0.0/16"] } },
			{ ipBlock: { cidr: "::/0", except: ["fd00:ec2::254/128"] } },
		]);
	});

	test("NetworkPolicy selectors are configurable; allowAll opens web; enabled=false drops them", () => {
		// Helm merges maps with the defaults: a default label is removed by setting it to null.
		const custom = render(
			"--set",
			"networkPolicy.web.allowAll=true",
			"--set-json",
			'networkPolicy.keda={"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":null,"name":"autoscaling"}},"podSelector":{"matchLabels":{"app":"keda"}}}',
		);
		expect(find(custom, "NetworkPolicy", "agentbot-web").spec.ingress).toEqual([{ ports: [{ port: 8080, protocol: "TCP" }] }]);
		expect(find(custom, "NetworkPolicy", "agentbot-orchestrator").spec.ingress?.[0]?.from?.[2]).toEqual({
			namespaceSelector: { matchLabels: { name: "autoscaling" } },
			podSelector: { matchLabels: { app: "keda" } },
		});
		expect(render("--set", "networkPolicy.enabled=false").some(o => o.kind === "NetworkPolicy")).toBe(false);
	});

	test("Ingress on: TLS for the host, routed to web:8080", () => {
		const ingress = find(
			render("--set", "web.ingress.enabled=true", "--set", "web.ingress.host=bot.example.org", "--set", "web.ingress.tls.secretName=bot-tls", "--set", "web.ingress.className=nginx"),
			"Ingress",
			"agentbot-web",
		);
		expect(ingress.spec.tls).toEqual([{ hosts: ["bot.example.org"], secretName: "bot-tls" }]);
		expect(ingress.spec.rules?.map(r => r.host)).toEqual(["bot.example.org"]);
		// Without a secret name the controller's default certificate still serves TLS.
		const fallback = find(render("--set", "web.ingress.enabled=true"), "Ingress", "agentbot-web");
		expect(fallback.spec.tls).toEqual([{ hosts: ["agentbot.example.com"] }]);
	});

	test("existingSecret: no generated Secret; every consumer reads the given one", () => {
		const objects = render("--set", "secrets.existingSecret=my-secrets");
		expect(objects.some(o => o.kind === "Secret")).toBe(false);
		for (const name of ["agentbot-orchestrator", "agentbot-web"]) expect(secretVolume(podSpec(find(objects, "Deployment", name))).secretName).toBe("my-secrets");
		expect(secretVolume(podSpec(find(objects, "ScaledJob", "agentbot-worker"))).secretName).toBe("my-secrets");
		expect(find(objects, "TriggerAuthentication", "agentbot-scale").spec.secretTargetRef?.[0]?.name).toBe("my-secrets");
	});

	test("worker values reach the ScaledJob and the orchestrator's capacity", () => {
		const objects = render(
			"--set",
			"worker.maxReplicas=3",
			"--set",
			"worker.diskLimit=5Gi",
			"--set",
			"worker.image.repository=ghcr.io/me/agentbot-worker",
			"--set",
			"image.tag=0.1.42",
			"--set",
			"web.vscode=false",
			"--set",
			"worker.nodeSelector.pool=workers",
		);
		const job = find(objects, "ScaledJob", "agentbot-worker");
		expect(job.spec.maxReplicaCount).toBe(3);
		const spec = podSpec(job);
		expect(spec.nodeSelector).toEqual({ pool: "workers" });
		expect(spec.containers[0]?.image).toBe("ghcr.io/me/agentbot-worker:0.1.42");
		expect(spec.containers[0] && env(spec.containers[0]).AGENTBOT_WORKER_DISK).toBe("5g");
		expect(spec.volumes.find(v => v.name === "checkout")?.emptyDir?.sizeLimit).toBe("5Gi");
		const orch = podSpec(find(objects, "Deployment", "agentbot-orchestrator")).containers[0];
		expect(orch?.image).toBe("ghcr.io/factotuminok/agentbot:0.1.42");
		expect(orch && env(orch).AGENTBOT_WORKER_CAPACITY).toBe("3");
		const web = podSpec(find(objects, "Deployment", "agentbot-web")).containers[0];
		expect(web && env(web).AGENTBOT_WEB_VSCODE).toBe("off");
	});

	test("fails without the KEDA ScaledJob API, unless the check is skipped", () => {
		const out = helm(["template", "agentbot", CHART, "--namespace", "agentbot"]);
		expect(out.code).not.toBe(0);
		expect(out.stderr).toContain("KEDA is not installed: this cluster has no keda.sh/v1alpha1 ScaledJob API");
		const skipped = helm(["template", "agentbot", CHART, "--namespace", "agentbot", "--set", "keda.skipCrdCheck=true"]);
		expect(skipped.stderr).toBe("");
		expect(skipped.code).toBe(0);
	});

	test("fails on Kubernetes older than 1.27 and on a bad disk limit", () => {
		const old = helm(["template", "agentbot", CHART, "--api-versions", KEDA_API, "--kube-version", "1.26.9"]);
		expect(old.code).not.toBe(0);
		expect(old.stderr).toContain("chart requires kubeVersion: >= 1.27.0-0 which is incompatible with Kubernetes v1.26.9");
		expect(helm(["template", "agentbot", CHART, "--api-versions", KEDA_API, "--kube-version", "1.27.0"]).code).toBe(0);
		const disk = helm(["template", "agentbot", CHART, "--api-versions", KEDA_API, "--set", "worker.diskLimit=20G"]);
		expect(disk.code).not.toBe(0);
		expect(disk.stderr).toContain("worker.diskLimit must be a whole number of Ki, Mi, Gi or Ti");
	});
});
