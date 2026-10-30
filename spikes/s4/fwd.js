// Spike-only TCP forwarder 0.0.0.0:13338 -> 127.0.0.1:13337, so code-server itself stays on loopback.
const net = require("node:net");
net.createServer(client => {
	const upstream = net.connect(13337, "127.0.0.1");
	client.pipe(upstream).pipe(client);
	const close = () => {
		client.destroy();
		upstream.destroy();
	};
	client.on("error", close);
	upstream.on("error", close);
}).listen(13338, "0.0.0.0");
