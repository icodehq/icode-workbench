'use strict'

/**
 * Extra `docker run` arguments for an explicit DNS resolver.
 *
 * GitHub-hosted runners occasionally lose the Docker embedded resolver, which
 * makes `apt-get update` inside the pinned build image fail with "Could not
 * resolve archive.ubuntu.com". CI sets ICODE_DOCKER_DNS to a comma-separated
 * list; local builds leave it unset and keep the daemon's DNS settings.
 */
function dockerDnsArgs(env = process.env) {
  const value = env.ICODE_DOCKER_DNS
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => ['--dns', entry])
}

module.exports = { dockerDnsArgs }
