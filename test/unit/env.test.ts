import { describe, expect, test } from "bun:test";
import { loadEnv } from "../../src/shared/env";

describe("security settings in the environment (requirements §13)", () => {
	test("AGENTBOT_WEB_TRUSTED_PROXIES takes addresses and CIDRs and rejects anything else", () => {
		expect(loadEnv({}).webTrustedProxies).toEqual([]);
		expect(loadEnv({ AGENTBOT_WEB_TRUSTED_PROXIES: " 10.0.0.0/8, fd00::/8,192.0.2.1 " }).webTrustedProxies).toEqual(["10.0.0.0/8", "fd00::/8", "192.0.2.1"]);
		for (const bad of ["proxy.local", "10.0.0.0/33", "fd00::/129", "10.0.0.0/8/1", "10.0.0.0/x"]) {
			expect(() => loadEnv({ AGENTBOT_WEB_TRUSTED_PROXIES: bad })).toThrow("AGENTBOT_WEB_TRUSTED_PROXIES");
		}
	});

	test("AGENTBOT_WORKER_ADDRESS_BINDING is on unless turned off", () => {
		expect(loadEnv({}).workerAddressBinding).toBe(true);
		expect(loadEnv({ AGENTBOT_WORKER_ADDRESS_BINDING: "off" }).workerAddressBinding).toBe(false);
		expect(() => loadEnv({ AGENTBOT_WORKER_ADDRESS_BINDING: "maybe" })).toThrow("AGENTBOT_WORKER_ADDRESS_BINDING");
	});

	test("AGENTBOT_WORKER_CPUS defaults to 2 and takes whole or fractional CPUs (F7)", () => {
		expect(loadEnv({}).workerCpus).toBe(2);
		expect(loadEnv({ AGENTBOT_WORKER_CPUS: "1.5" }).workerCpus).toBe(1.5);
		expect(loadEnv({ AGENTBOT_WORKER_CPUS: "0.01" }).workerCpus).toBe(0.01);
		for (const bad of ["0", "0.001", "-1", "two", "1,5", "2000"]) {
			expect(() => loadEnv({ AGENTBOT_WORKER_CPUS: bad })).toThrow("AGENTBOT_WORKER_CPUS");
		}
	});
});
