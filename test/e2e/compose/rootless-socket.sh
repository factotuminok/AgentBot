# shellcheck shell=bash
# Sourced by the compose e2e scripts (test/e2e/compose/README.md, "How it reaches the rootless engine").
#
#   forward_rootless_socket <connection> <dir>
# Points `podman compose` at the rootless engine of Podman connection <connection> (empty = the local podman):
# exports CONTAINER_CONNECTION (podman-compose follows it) and DOCKER_HOST (docker-compose talks to it). For an ssh
# connection, as on a podman machine, the host's socket is forwarded to <dir>/podman.sock over the connection's ssh.
# Sets host_sock (the socket's path on the Podman host, for AGENTBOT_HOST_PODMAN_SOCKET) and forward_pid (the ssh
# forward to kill afterwards, or empty).
#
#   on_podman_host <connection> <shell command>
# Runs a command on the Podman host as the connection's user (over its ssh), or locally for an empty or local connection.

# Sets ssh_args to the ssh command line of an ssh connection (empty otherwise).
connection_ssh() {
	local uri hostport user
	ssh_args=()
	uri="$([ -n "$1" ] && podman system connection ls --format '{{.Name}} {{.URI}} {{.Identity}}' | awk -v n="$1" '$1 == n { print $2, $3 }' || true)"
	case "$uri" in
	ssh://*)
		set -- $uri
		hostport="${1#ssh://}"
		hostport="${hostport%%/*}"
		user="${hostport%@*}"
		hostport="${hostport#*@}"
		ssh_args=(ssh -i "$2" -p "${hostport##*:}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$user@${hostport%:*}")
		;;
	esac
}

forward_rootless_socket() {
	local conn="$1" dir="$2"
	local p=(podman)
	forward_pid=""
	if [ -n "$conn" ]; then
		p=(podman --connection "$conn")
		export CONTAINER_CONNECTION="$conn"
	fi
	host_sock="$("${p[@]}" info --format '{{.Host.RemoteSocket.Path}}')"
	host_sock="${host_sock#unix://}"
	connection_ssh "$conn"
	if [ ${#ssh_args[@]} = 0 ]; then
		export DOCKER_HOST="unix://$host_sock"
		return
	fi
	"${ssh_args[@]}" -o ExitOnForwardFailure=yes -nNT -L "$dir/podman.sock:$host_sock" &
	forward_pid=$!
	for _ in $(seq 1 50); do [ -S "$dir/podman.sock" ] && break; sleep 0.1; done
	[ -S "$dir/podman.sock" ] || { echo "FAIL: could not forward $host_sock" >&2; return 1; }
	export DOCKER_HOST="unix://$dir/podman.sock"
}

on_podman_host() {
	connection_ssh "$1"
	if [ ${#ssh_args[@]} = 0 ]; then sh -c "$2"; else "${ssh_args[@]}" "$2"; fi
}
