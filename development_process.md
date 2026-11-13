# ForgeQueue --- Phase 2: Development Environment Setup

> **Document status:** Phase 2 environment reference\
> **Project:** ForgeQueue\
> **Stack:** TypeScript, Node.js, Express.js, PostgreSQL\
> **Environment:** Android + Termux, with an Ubuntu 26.04.1 LTS PRoot
> environment\
> **Scope:** Development-environment setup only. This document
> distinguishes completed work from pending implementation.

------------------------------------------------------------------------

## 1. Phase 2 overview

Phase 2 established the local development environment for ForgeQueue.
The work covered the runtime environment, PostgreSQL availability,
initial database and application role creation, Node.js project
initialization, dependency installation, TypeScript configuration, Git
exclusions, npm scripts, and the initial application entry point.

The environment is unusual because it runs on Android. Termux provides
native Android command-line packages, while `proot-distro` provides an
Ubuntu userland. These environments have separate filesystems, package
managers, executable paths, and process/ownership behavior. The
PostgreSQL setup exposed why that separation matters.

### 1.1 Goals

-   Establish a reproducible Node.js and TypeScript project.
-   Provide a local PostgreSQL database for future application
    development.
-   Keep application credentials separate from PostgreSQL superuser
    credentials.
-   Configure a strict TypeScript build.
-   Separate development execution from compiled production execution.
-   Exclude generated files and secrets from Git.
-   Record unresolved work without representing it as complete.

### 1.2 Completion boundary

The environment and initial project scaffolding were established.
Database connectivity from the application, migrations, job processing,
and the job submission API remain future implementation work. A database
and role existing in PostgreSQL does **not** mean the Express
application is already connected to PostgreSQL.

------------------------------------------------------------------------

## 2. Development environment

### 2.1 Environment inventory

  -------------------------------------------------------------------------
  Component               Environment / version     Status
  ----------------------- ------------------------- -----------------------
  Host device             Android device            In use

  Native terminal         Termux                    In use

  Linux userland          Ubuntu 26.04.1 LTS        Available
                          through `proot-distro`    

  Node.js                 v26.4.0                   Verified by the user

  npm                     v11.21.1                  Verified by the user

  PostgreSQL              18.6, Termux-native       Running; accepting
                                                    connections was
                                                    observed

  Git                     Installed; repository     In use
                          initialized               

  Project                 `~/projects/forgequeue`   Initialized
  -------------------------------------------------------------------------

The PostgreSQL server ultimately used for this development environment
is the **Termux-native PostgreSQL installation**, not the Ubuntu PRoot
installation attempt.

### 2.2 Termux and Ubuntu are separate execution environments

Termux is an Android-native Linux-like environment. `proot-distro`
launches an Ubuntu userland inside Termux without providing a
conventional virtual machine or a full Linux host kernel.

The two environments can have different copies of tools with the same
executable name. For example, `psql` found through `PATH` may be the
Termux executable even while the current shell appears to be inside
Ubuntu, if paths have been inherited or otherwise mixed.

Typical path roots:

  -----------------------------------------------------------------------
  Environment                         Typical prefix / root
  ----------------------------------- -----------------------------------
  Termux                              `$PREFIX`, commonly
                                      `/data/data/com.termux/files/usr`

  Ubuntu PRoot                        `/usr`, `/etc`, `/var`, and the
                                      Ubuntu root filesystem
  -----------------------------------------------------------------------

Do not assume that a command is using the current environment's package
installation merely because the prompt looks like Ubuntu. Verify
executable resolution:

``` bash
which psql
which postgres
which pg_ctl
```

`which` reports the executable selected through the current shell's
`PATH`. The returned path is important diagnostic evidence.

Useful environment checks:

``` bash
proot-distro list
proot-distro login ubuntu
cat /etc/os-release
```

-   `proot-distro list` lists installed PRoot distributions.
-   `proot-distro login ubuntu` starts a shell in the Ubuntu
    distribution.
-   `cat /etc/os-release` identifies the userland distribution and
    release.

**Operational rule:** Keep package installation and service management
within one environment for a given tool. Do not combine a Termux
PostgreSQL server with Ubuntu PostgreSQL cluster-management assumptions.

------------------------------------------------------------------------

## 3. PostgreSQL installation and environment troubleshooting

### 3.1 Initial Ubuntu installation attempt

PostgreSQL was initially approached from the Ubuntu PRoot environment.
The `postgresql-contrib` package was not available under the attempted
package setup. The installation path was simplified to the main
PostgreSQL package rather than treating the contrib package as a
prerequisite.

The initial diagnostic commands included:

``` bash
proot-distro login ubuntu
cat /etc/os-release
which psql
which postgres
which pg_ctl
pg_lsclusters
```

The purpose was to establish: 1. Which distribution shell was active. 2.
Which PostgreSQL client/server binaries were actually being invoked. 3.
Whether Ubuntu's cluster-management utilities were available.

### 3.2 `pg_lsclusters` was missing

`pg_lsclusters` is a Debian/Ubuntu cluster-management utility. Its
absence in the Termux environment is not evidence that PostgreSQL itself
is absent. It is also not a portable PostgreSQL server command.

The investigation found that PostgreSQL binaries were resolving from
Termux rather than the expected Ubuntu installation. This explained why
Ubuntu-specific cluster tooling and the selected PostgreSQL executables
did not form a consistent installation.

Check the selected binary paths before running environment-specific
commands:

``` bash
which psql
which postgres
which pg_ctl
pg_lsclusters
```

Do not infer that all PostgreSQL tools belong to the same installation
simply because they share a command name.

### 3.3 Ubuntu cluster creation attempt

The Ubuntu PostgreSQL path was then explored using:

``` bash
pg_createcluster 18 main
pg_ctlcluster 18 main start
```

-   `pg_createcluster 18 main` requests creation of a PostgreSQL 18
    cluster named `main` using Debian/Ubuntu cluster tooling.
-   `pg_ctlcluster 18 main start` requests startup of that cluster
    through the distribution's management wrapper.

These commands are distribution-specific. They should only be used when
the matching Ubuntu/Debian PostgreSQL packages, cluster utilities,
filesystem layout, and ownership model are actually in place.

### 3.4 PRoot ownership failure

The Ubuntu cluster attempt encountered a filesystem ownership problem.
PostgreSQL expects its data directory and server process to be
controlled by the dedicated PostgreSQL operating-system account. The
PRoot environment did not reproduce the expected ownership behavior.

The troubleshooting included attempts to switch identity and change
ownership:

``` bash
runuser
chown postgres:postgres <data-directory>
```

The observed behavior was:

-   `runuser` could switch the reported user identity.
-   Files created in the attempted workflow still appeared owned by
    UID/GID `0:0`.
-   `chown postgres:postgres` did not result in the expected ownership
    change; ownership continued to report as root.

This is a PRoot/filesystem boundary issue, not a PostgreSQL SQL-role
issue. A PostgreSQL database role and a Linux operating-system user are
different identity systems.

**Why it mattered:** PostgreSQL's server process and data directory rely
on OS-level ownership and permission guarantees. If PRoot cannot provide
the expected ownership semantics, repeatedly retrying cluster commands
does not solve the underlying constraint.

### 3.5 Resolution: use Termux-native PostgreSQL

The implementation decision was to use Termux-native PostgreSQL 18.6
rather than continue trying to make Ubuntu's cluster ownership model
work inside PRoot.

This avoids mixing: - Ubuntu cluster wrappers, - Termux PostgreSQL
binaries, - incompatible data-directory assumptions, - and ownership
semantics that were not behaving as PostgreSQL expected.

The Termux-native server was initialized and started successfully. The
user observed PostgreSQL accepting connections.

This is an environment-specific decision for the current development
setup. It does not imply that production ForgeQueue should run
PostgreSQL inside Termux or Android.

### 3.6 Termux PostgreSQL initialization

Initialize a new PostgreSQL data directory:

``` bash
initdb -D "$PREFIX/var/lib/postgresql"
```

`initdb` creates the database cluster's initial filesystem structure and
system catalogs. It is a one-time initialization step for a new data
directory. Do not rerun it against an existing cluster that contains
data.

Start the server:

``` bash
pg_ctl -D "$PREFIX/var/lib/postgresql" \
  -l "$PREFIX/var/lib/postgresql/server.log" start
```

-   `pg_ctl` is PostgreSQL's server-control utility.
-   `-D` identifies the cluster's data directory.
-   `-l` sends server log output to the specified file.
-   `start` starts the PostgreSQL server process.

Check whether the server is accepting connections:

``` bash
pg_isready
```

`pg_isready` checks PostgreSQL connection status. A successful response
commonly resembles:

``` text
/var/run/postgresql:5432 - accepting connections
```

The exact socket path and wording can vary by environment. The important
status is `accepting connections`. The user reported that the Termux
PostgreSQL server was running and accepting connections.

To inspect the server log when startup fails:

``` bash
tail -n 100 "$PREFIX/var/lib/postgresql/server.log"
```

This is a diagnostic command; it should be used when investigating an
actual startup failure.

**Important:** `pg_isready` verifies server availability at the
PostgreSQL protocol level. It does not verify that the ForgeQueue
application role can authenticate, that the target database exists, or
that the application schema is ready.

------------------------------------------------------------------------

## 4. PostgreSQL database and application role

### 4.1 Resources created

  -----------------------------------------------------------------------
  Resource                Name                    Purpose
  ----------------------- ----------------------- -----------------------
  Database                `forgequeue`            Local application
                                                  database

  Application role        `forgequeue_user`       Login identity for the
                                                  application

  Database owner          `forgequeue_user`       Owns the `forgequeue`
                                                  database
  -----------------------------------------------------------------------

The user confirmed that the role exists and that the `forgequeue`
database exists with `forgequeue_user` as its owner.

The Termux administrative role was observed as `u0_a523` and had
superuser privileges. That identity is an environment-level
administrative account; it should not become the application's runtime
identity.

### 4.2 Role creation

The application role was created using a password supplied locally:

``` sql
CREATE ROLE forgequeue_user
WITH LOGIN PASSWORD 'your_local_password';
```

`LOGIN` permits the role to authenticate as a database connection user.
The password shown above is a placeholder only. **Never put the actual
local password in this document, source control, logs, or screenshots.**

A PostgreSQL role is a database-level identity. Roles can own objects,
receive privileges, and authenticate when configured with `LOGIN`.

### 4.3 Database creation and ownership

``` sql
CREATE DATABASE forgequeue
OWNER forgequeue_user;
```

The `OWNER` clause makes `forgequeue_user` the database owner. Ownership
provides the role with control over the database itself and is a
sensible starting point for a dedicated local application database.

### 4.4 Why the application must not use a superuser

The application should authenticate as `forgequeue_user`, not as the
Termux administrative superuser.

A superuser can bypass normal privilege checks and perform
administrative operations across the PostgreSQL instance. If application
credentials are exposed or an application bug is exploited, superuser
credentials create an unnecessarily large blast radius.

The production privilege model should be narrower still: grant only the
permissions needed by the application and separate
migration/administrative permissions from normal runtime permissions
where practical.

### 4.5 Connect as the application role

``` bash
psql -h 127.0.0.1 -U forgequeue_user -d forgequeue -W
```

-   `-h 127.0.0.1` connects over TCP to the local host.
-   `-U forgequeue_user` selects the application role.
-   `-d forgequeue` selects the target database.
-   `-W` explicitly prompts for a password.

Using `127.0.0.1` makes the TCP connection explicit rather than relying
on a default Unix-domain socket.

### 4.6 Verify identity and database

Inside `psql`:

``` sql
SELECT current_user, current_database();
```

Expected result values:

  Column               Expected value
  -------------------- -------------------
  `current_user`       `forgequeue_user`
  `current_database`   `forgequeue`

This is the meaningful authentication check: it confirms the identity
and database for the active session.

List roles:

``` text
\du
```

List databases:

``` text
\l
```

These are `psql` meta-commands, not SQL statements. They are executed
inside the interactive `psql` shell.

------------------------------------------------------------------------

## 5. Node.js project initialization

### 5.1 Project directory

The project was created at:

``` text
~/projects/forgequeue
```

Commands:

``` bash
mkdir -p ~/projects/forgequeue
cd ~/projects/forgequeue
```

-   `mkdir -p` creates the directory and any missing parent directories.
    It does not fail merely because the directory already exists.
-   `cd` changes the current shell directory.

### 5.2 Git initialization

``` bash
git init
```

`git init` creates a local Git repository in the project directory. It
establishes the repository metadata needed to track changes, create
commits, and manage branches.

The observed repository branch was `main`. At the time of the recorded
status, there were no commits and the project files were untracked. A
Git repository being initialized does not mean the project has already
been committed or pushed to a remote.

### 5.3 npm initialization

``` bash
npm init -y
```

`npm init` creates `package.json`, the Node.js project's package
manifest. The `-y` option accepts the default answers rather than
prompting for each field.

The manifest records project metadata, dependencies, package type,
entry-point metadata, and npm scripts. It is the central configuration
file npm uses to manage the project.

------------------------------------------------------------------------

## 6. Dependencies

### 6.1 Production dependencies

Installed using:

``` bash
npm install express pg dotenv
```

  -----------------------------------------------------------------------
  Package                             Purpose
  ----------------------------------- -----------------------------------
  `express`                           HTTP server framework, middleware
                                      pipeline, and API routing

  `pg`                                PostgreSQL client for Node.js;
                                      supports queries and connection
                                      pooling

  `dotenv`                            Loads key/value configuration from
                                      a local `.env` file into
                                      `process.env`
  -----------------------------------------------------------------------

The recorded installed package versions were:

  Package       Recorded version
  ----------- ------------------
  `dotenv`                18.0.9
  `express`                5.3.0
  `pg`                    8.23.1

These are the versions recorded during setup; the lockfile is the source
of truth for the complete resolved dependency tree.

### 6.2 Development dependencies

Installed using:

``` bash
npm install -D typescript tsx vitest @types/node @types/express
```

  -----------------------------------------------------------------------
  Package                             Purpose
  ----------------------------------- -----------------------------------
  `typescript`                        TypeScript compiler and static type
                                      checker

  `tsx`                               Executes TypeScript files directly
                                      and supports watch mode for
                                      development

  `vitest`                            Test runner for automated tests

  `@types/node`                       Type declarations for Node.js APIs

  `@types/express`                    Type declarations for Express APIs
  -----------------------------------------------------------------------

`-D` (equivalent to `--save-dev`) places these packages in
`devDependencies`. They support development, compilation, and testing
rather than being runtime application dependencies.

### 6.3 TypeScript 7 ARM64 compatibility issue

The initial TypeScript installation path encountered a compatibility
problem on the Android ARM64 environment. TypeScript 7 was not usable in
this setup, so the project pinned TypeScript to the known compatible
5.9.3 release:

``` bash
npm install -D typescript@5.9.3
```

This is a compatibility pin for the current development environment, not
a claim that TypeScript 7 is universally incompatible with ARM64.
Compatibility depends on the actual runtime, package distribution, and
platform support.

Pinning avoids an uncontrolled compiler-version change while the project
is being established. Revisit the pin deliberately when the target
environment and toolchain are validated.

### 6.4 Version verification

``` bash
node -v
npm -v

npx tsc --version
npx tsx --version
npx vitest --version
```

The user-observed runtime versions were:

``` text
Node.js: v26.4.0
npm:     11.21.1
```

The TypeScript pin requested for this environment is `5.9.3`. The
commands above should be run from the project directory so `npx`
resolves the project's local development dependencies.

Do not record a version as verified unless the command output has
actually been observed.

### 6.5 esbuild TypeScript transform verification

`tsx` uses esbuild as part of its TypeScript execution path. A small
transform test can verify that the installed esbuild package can parse
and transform TypeScript syntax:

``` bash
node -e "require('esbuild').transformSync('const x: number = 10', {loader: 'ts'}); console.log('esbuild works')"
```

Expected output if successful:

``` text
esbuild works
```

This checks a basic TypeScript transform. It does not prove that the
entire ForgeQueue project type-checks, builds, or runs correctly.

------------------------------------------------------------------------

## 7. Git configuration

### 7.1 `.gitignore`

The project `.gitignore` contains:

``` gitignore
node_modules/
.env
.env.*
!.env.example
dist/
coverage/
```

  -----------------------------------------------------------------------
  Entry                               Reason
  ----------------------------------- -----------------------------------
  `node_modules/`                     Excludes installed dependency
                                      files; they are reproducible from
                                      the package manifest and lockfile

  `.env`                              Excludes local secrets and
                                      machine-specific configuration

  `.env.*`                            Excludes environment-specific
                                      variants such as `.env.local`

  `!.env.example`                     Re-includes the safe example
                                      template despite the `.env.*`
                                      exclusion

  `dist/`                             Excludes generated TypeScript build
                                      output

  `coverage/`                         Excludes generated test coverage
                                      reports
  -----------------------------------------------------------------------

The exception `!.env.example` is intentional. It allows the project to
share the names and shape of required configuration variables without
publishing actual credentials.

### 7.2 Why `package-lock.json` should be committed

`package-lock.json` should be committed to Git.

It records the resolved dependency tree, including package versions and
integrity metadata. This helps developers and CI environments install a
consistent dependency graph using `npm ci`.

Do not add `package-lock.json` to `.gitignore`. Unlike `node_modules/`,
it is a source-controlled project artifact.

------------------------------------------------------------------------

## 8. TypeScript configuration

### 8.1 Configuration creation

The initial configuration command was:

``` bash
npx tsc --init
```

This generates a `tsconfig.json` file with TypeScript compiler
configuration. The project configuration was then set to the following:

``` json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "./src",
    "outDir": "./dist",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### 8.2 Compiler option reference

  ------------------------------------------------------------------------------
  Option                                     Meaning and reason
  ------------------------------------------ -----------------------------------
  `target: "ES2022"`                         Emits JavaScript targeting the
                                             ES2022 language level. This is a
                                             deliberate runtime target rather
                                             than relying on an unspecified
                                             default.

  `module: "NodeNext"`                       Uses Node.js-aware module output
                                             rules, respecting package/module
                                             context and Node's ESM/CommonJS
                                             behavior.

  `moduleResolution: "NodeNext"`             Resolves imports using Node.js's
                                             modern package and
                                             module-resolution rules. It should
                                             match the selected module mode.

  `rootDir: "./src"`                         Defines the source root used to
                                             preserve the source directory
                                             structure in emitted output.

  `outDir: "./dist"`                         Writes generated JavaScript and
                                             related build artifacts to `dist/`.

  `strict: true`                             Enables the strict family of
                                             type-checking options, catching
                                             more type errors during
                                             development.

  `esModuleInterop: true`                    Improves compatibility when
                                             importing CommonJS packages from
                                             TypeScript using ES-style import
                                             syntax.

  `forceConsistentCasingInFileNames: true`   Reports imports whose file-name
                                             casing is inconsistent, reducing
                                             cross-platform path bugs.

  `skipLibCheck: true`                       Skips type checking of declaration
                                             files from dependencies. It can
                                             reduce build time; it does not
                                             disable checking of the project's
                                             own TypeScript source.

  `declaration: true`                        Emits `.d.ts` declaration files
                                             alongside compiled output. Useful
                                             when publishing or consuming the
                                             project as a typed package; it may
                                             be unnecessary for a private
                                             service but is currently
                                             configured.

  `sourceMap: true`                          Emits source maps so compiled
                                             JavaScript can be mapped back to
                                             TypeScript during debugging.

  `include`                                  Limits the selected source files to
                                             TypeScript files under `src/`.

  `exclude`                                  Excludes `node_modules` and
                                             generated `dist` files from the
                                             compiler's source-file discovery.
  ------------------------------------------------------------------------------

### 8.3 NodeNext and ES modules

`NodeNext` aligns TypeScript's module behavior with modern Node.js. It
considers package metadata such as `"type": "module"` and Node's
file-extension rules.

With `"type": "module"` in `package.json`, `.js` files in this package
are interpreted as ES modules by Node.js. In NodeNext projects, relative
imports in TypeScript source commonly need to use the emitted JavaScript
extension in the import specifier, for example:

``` ts
import { helper } from "./helper.js";
```

The source file can still be `helper.ts`; TypeScript resolves the `.js`
specifier to the TypeScript source during compilation under NodeNext
rules. Follow this convention consistently as the source tree grows.

### 8.4 Source and output directories

-   `src/` contains maintained TypeScript source code.
-   `dist/` contains generated JavaScript and build artifacts.
-   Developers edit `src/`, not the generated files in `dist/`.
-   `dist/` is excluded from Git because it can be recreated by the
    build.

Inspect the effective compiler configuration with:

``` bash
npx tsc --showConfig
```

This prints the resolved configuration after TypeScript applies defaults
and reads the project configuration. It is useful for diagnosing
unexpected compiler behavior.

------------------------------------------------------------------------

## 9. `package.json` configuration

The project metadata and scripts were configured using:

``` bash
npm pkg set type=module
npm pkg set main=dist/index.js
npm pkg set scripts.dev="tsx watch src/index.ts"
npm pkg set scripts.build="tsc"
npm pkg set scripts.start="node dist/index.js"
npm pkg set scripts.test="vitest run"
```

`npm pkg set` edits fields in `package.json` without requiring manual
JSON editing.

### 9.1 Configuration reference

  --------------------------------------------------------------------------
  Field                   Value                      Purpose
  ----------------------- -------------------------- -----------------------
  `type`                  `module`                   Treats package `.js`
                                                     files as ES modules in
                                                     Node.js

  `main`                  `dist/index.js`            Declares the package
                                                     entry point for
                                                     consumers that resolve
                                                     the package's main
                                                     entry

  `scripts.dev`           `tsx watch src/index.ts`   Runs the TypeScript
                                                     entry point and
                                                     restarts/reloads during
                                                     development changes

  `scripts.build`         `tsc`                      Runs the TypeScript
                                                     compiler using
                                                     `tsconfig.json`

  `scripts.start`         `node dist/index.js`       Runs the compiled
                                                     JavaScript entry point

  `scripts.test`          `vitest run`               Runs the Vitest test
                                                     suite once, suitable
                                                     for non-watch execution
  --------------------------------------------------------------------------

### 9.2 Why ES modules

ES modules are the standard JavaScript module system supported by modern
Node.js. They use `import` and `export` syntax and provide a consistent
module model across TypeScript source and emitted JavaScript.

The project explicitly configures `"type": "module"` and uses
TypeScript's `NodeNext` mode so the compiler and runtime agree about
module behavior.

### 9.3 Development versus production execution

Development:

``` bash
npm run dev
```

This runs `src/index.ts` through `tsx` in watch mode. It avoids a manual
compile step after every source edit and is intended for local
development.

Build:

``` bash
npm run build
```

This invokes `tsc` and emits compiled artifacts into `dist/`. A
successful TypeScript build is a compile-time check; it does not
automatically prove database connectivity or application-level
correctness.

Production-style local execution:

``` bash
npm start
```

This runs `node dist/index.js`. It assumes that `npm run build` has
already produced the compiled entry point.

The production execution path intentionally runs JavaScript generated by
the compiler rather than executing TypeScript source directly.

------------------------------------------------------------------------

## 10. Initial application entry point and Express server

### 10.1 Initial entry-point evolution

The first entry-point experiment was a minimal TypeScript module:

``` ts
console.log("ForgeQueue initialized successfully!");

export function hello(): string {
  return "Hello from ForgeQueue!";
}
```

This established a TypeScript source file with a side effect
(`console.log`) and a named exported function with an explicit return
type.

The entry point then evolved into an Express HTTP server with a
`/health` endpoint. The exact final server implementation should be
treated as the source of truth in `src/index.ts`; this note documents
its responsibilities rather than claiming additional database behavior
that has not yet been implemented.

### 10.2 Express application concepts

An Express application is created with `express()`. The returned
application object represents the HTTP application and provides methods
for middleware registration and route definitions.

JSON middleware is commonly registered using:

``` ts
app.use(express.json());
```

This middleware parses incoming JSON request bodies and exposes the
parsed value through `req.body` for requests with an appropriate content
type. It does not validate the application's domain schema; request
validation must be implemented separately.

An HTTP GET route is registered using:

``` ts
app.get("/health", handler);
```

The handler receives request and response objects. A health route
typically returns a small response indicating the process is available.

### 10.3 HTTP 200 and health checks

HTTP `200 OK` means the request was successfully handled. For a simple
liveness endpoint, a `200` response can indicate that the process is
running and able to serve HTTP requests.

A `200` from a process-only health endpoint does **not** prove that
PostgreSQL is reachable or that a job can be safely persisted.

### 10.4 Liveness versus readiness

  -----------------------------------------------------------------------
  Check                   Question answered       Typical behavior
  ----------------------- ----------------------- -----------------------
  Liveness                Is the process alive    Should generally avoid
                          and not irrecoverably   depending on external
                          stuck?                  services

  Readiness               Can this instance       Should include required
                          safely accept the work  dependencies such as
                          it advertises?          PostgreSQL
  -----------------------------------------------------------------------

A database-dependent service should not report itself ready to accept
durable job submissions when PostgreSQL is unavailable.

### 10.5 Why a job must be persisted before acknowledgement

ForgeQueue is intended to process background jobs. If the API
acknowledges a job before it is durably stored, the client may believe
the job was accepted even though a process crash or database outage can
cause the job to disappear.

The safe acceptance sequence is conceptually:

1.  Validate the incoming job request.
2.  Apply idempotency rules where applicable.
3.  Persist the job transactionally in PostgreSQL.
4.  Only after the persistence operation succeeds, return an accepted
    response to the client.

If PostgreSQL is unavailable or the transaction fails, the API must not
claim that the job was durably accepted. A service-unavailable response
such as HTTP `503` may be appropriate when the service cannot currently
fulfill the request because a required dependency is unavailable.

This is an architectural requirement for the future job-submission path,
not a claim that the job API has already been implemented.

### 10.6 Run commands

``` bash
npm run dev
npm run build
npm start
```

-   Use `npm run dev` while actively editing source code.
-   Use `npm run build` to type-check and compile the configured
    TypeScript source.
-   Use `npm start` to run the compiled entry point after a successful
    build.

The exact runtime output depends on the current `src/index.ts`. Do not
assume the server's port or a successful HTTP response unless it has
been observed in the current environment.

------------------------------------------------------------------------

## 11. Engineering concepts established in Phase 2

### 11.1 Durable storage

Durable storage retains data beyond the lifetime of an individual
process. In ForgeQueue, PostgreSQL is intended to store accepted jobs so
that restarting the API or worker does not erase the job record.

An in-memory array or queue is not durable: process termination destroys
its contents unless they are separately persisted.

### 11.2 PostgreSQL connection pooling

A connection pool reuses a bounded set of database connections instead
of opening a new connection for every request.

Benefits include: - Reduced connection setup overhead. - A controlled
maximum number of concurrent database connections. - Better coordination
between request handlers and the database server.

The `pg` package supports pooling through `Pool`. A pool module has
**not yet been implemented** in this phase.

### 11.3 Environment variables

Environment variables separate deployment-specific configuration from
source code. Database host, port, database name, username, and password
should not be hard-coded into application modules.

The `dotenv` package is installed, but the ForgeQueue `.env`
configuration and application-side loading are pending. The actual
password must remain local and must not be committed.

### 11.4 ES modules

ES modules use `import` and `export`. The project declares
`"type": "module"` and configures TypeScript with `NodeNext` so emitted
JavaScript follows Node.js module rules.

### 11.5 TypeScript compilation

TypeScript provides static analysis and type checking before execution.
`tsc` compiles the configured TypeScript source into JavaScript under
`dist/`.

Compilation catches many type and module errors, but it does not prove
that runtime dependencies, environment variables, database permissions,
or business logic are correct.

### 11.6 HTTP status codes: 200 and 503

-   `200 OK`: the request succeeded. Appropriate for a successful health
    response when the conditions represented by that health check are
    satisfied.
-   `503 Service Unavailable`: the service cannot currently handle the
    request, commonly because a required dependency is unavailable or
    the service is temporarily unable to accept work.

A health endpoint's status should reflect what it claims to measure. Do
not use `200` to imply database readiness if the endpoint never checks
PostgreSQL.

### 11.7 Liveness and readiness

Liveness asks whether the process is alive. Readiness asks whether the
process can safely receive traffic for its intended function.

For a durable job API, readiness should account for PostgreSQL because
job acceptance depends on persistence. A process can be live while not
ready.

### 11.8 Idempotency keys

An idempotency key is a client-provided identifier used to recognize
retries of the same logical operation. If a client times out after
submitting a job, it may retry because it does not know whether the
first request succeeded.

A correctly designed idempotency mechanism ensures that repeated
submissions with the same key do not create duplicate logical jobs. The
key and its uniqueness constraint need to be persisted in the database
and handled transactionally. Idempotency support is a design concept at
this stage; the job API and schema are not yet implemented.

### 11.9 Persist before acknowledgement

The API should acknowledge a job only after the database transaction
that records it succeeds. This prevents a false acceptance signal when a
job was never durably stored.

The response should distinguish: - accepted and persisted, - rejected
due to invalid input, - duplicate/replayed idempotent request, -
temporarily unavailable because persistence is not possible.

The exact response contract will be defined with the job submission API.

### 11.10 Least-privilege database access

The application should use a dedicated database role with only the
privileges required for its work. It should not use a PostgreSQL
superuser.

This limits the damage caused by leaked credentials, SQL injection, or
application defects. Administrative tasks such as cluster management and
migrations may require a separate controlled identity.

------------------------------------------------------------------------

## 12. Current project structure

The known project structure at the end of this setup phase is:

``` text
forgequeue/
├── src/
│   └── index.ts
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
└── node_modules/
```

### 12.1 File status

  -----------------------------------------------------------------------
  Path                    Status                  Responsibility
  ----------------------- ----------------------- -----------------------
  `src/index.ts`          Implemented initial     Application entry point
                          entry point / Express   and initial HTTP health
                          server work             route

  `.gitignore`            Configured              Excludes generated
                                                  files and local secrets

  `package.json`          Configured              Project metadata,
                                                  dependencies, package
                                                  type, and scripts

  `package-lock.json`     Generated by npm;       Locks resolved
                          should be committed     dependency versions

  `tsconfig.json`         Configured              TypeScript compiler
                                                  behavior

  `node_modules/`         Generated by npm        Installed dependencies;
                                                  excluded from Git

  `dist/`                 Build output location;  Compiled JavaScript and
                          generated when build    related artifacts;
                          runs                    excluded from Git

  `notes/`                Documentation           Phase notes; this
                          destination             document is intended
                                                  for this directory
  -----------------------------------------------------------------------

`node_modules/` is generated and should not be committed. A developer
can recreate it from the manifest and lockfile with `npm ci`.

The tree above is the known setup-phase structure, not a claim that
every future module or directory has been created.

------------------------------------------------------------------------

## 13. Pending work --- not completed yet

The following items are explicitly **NOT COMPLETED YET**:

  -----------------------------------------------------------------------
  Pending item                        Why it is needed
  ----------------------------------- -----------------------------------
  `.env` configuration for database   Supplies local database settings
  connectivity                        without hard-coding secrets

  `.env.example`                      Documents required variable names
                                      without containing credentials

  PostgreSQL connection pool module   Centralizes and manages application
                                      database connections

  Database readiness endpoint         Reports whether the application can
                                      safely accept database-dependent
                                      work

  Automated tests                     Verifies behavior and guards
                                      against regressions

  Database schema and migrations      Defines durable job-related tables
                                      and repeatable schema changes

  Job submission API                  Accepts, validates, persists, and
                                      acknowledges new jobs
  -----------------------------------------------------------------------

Do not treat the existence of the PostgreSQL database as completion of
application database integration. The application has not yet been
documented as loading database credentials, creating a `pg.Pool`,
executing a query, or persisting a job.

------------------------------------------------------------------------

## 14. Troubleshooting record

  -----------------------------------------------------------------------
  Problem                 Diagnosis               Resolution / decision
  ----------------------- ----------------------- -----------------------
  `postgresql-contrib`    The requested package   Focused on the main
  package unavailable in  was not available in    PostgreSQL installation
  the attempted Ubuntu    that package            path
  setup                   environment; it was not 
                          required to continue    
                          basic setup             

  `pg_lsclusters` missing The command is          Checked executable
                          distribution-specific   paths and stopped
                          and was not available   assuming Ubuntu cluster
                          in the Termux toolset   tooling was present

  PostgreSQL binaries     `PATH` and environment  Used `which` to
  resolving from Termux   boundaries caused the   identify executable
  while in an Ubuntu      selected binaries to    locations and separated
  shell                   come from a different   the two environments
                          installation            

  Ubuntu cluster          PRoot did not provide   Tested `runuser` and
  creation/startup path   the expected PostgreSQL `chown`; observed root
  failed around ownership OS-level ownership      ownership remained
                          behavior                

  PostgreSQL              The PRoot               Abandoned that path and
  data-directory          filesystem/identity     used Termux-native
  ownership did not       model did not satisfy   PostgreSQL 18.6
  change as expected      the ownership           
                          assumptions of the      
                          Ubuntu cluster setup    

  TypeScript 7 was not    Toolchain/platform      Pinned the project to
  usable in the Android   compatibility issue     TypeScript 5.9.3
  ARM64 setup                                     
  -----------------------------------------------------------------------

### 14.1 General diagnostic lessons

1.  Verify the executable path before debugging a tool's behavior.
2.  Keep package-manager installations and their service-management
    tools within the same environment.
3.  Distinguish Linux OS users from PostgreSQL database roles.
4.  Read the database server log when startup fails; do not infer the
    cause from a client connection error alone.
5.  Verify database login as the application role, not only as an
    administrator.
6.  Pin toolchain versions when a platform-specific incompatibility is
    encountered.
7.  Distinguish a successful compiler run from a successful application
    runtime and from a successful database integration test.

------------------------------------------------------------------------

## 15. Environment verification checklist

Run these checks from the appropriate environment and record the actual
output when repeating the setup.

### 15.1 Environment

``` bash
proot-distro list
proot-distro login ubuntu
cat /etc/os-release
```

Expected evidence: - Ubuntu reports the intended Ubuntu release when
inside the PRoot shell. - Termux and Ubuntu are treated as separate
package/runtime environments.

### 15.2 Node.js and npm

Run in the environment used for the project:

``` bash
node -v
npm -v
```

Recorded versions:

``` text
v26.4.0
11.21.1
```

### 15.3 PostgreSQL binary selection and server status

Run in Termux for the selected PostgreSQL installation:

``` bash
which psql
which postgres
which pg_ctl
pg_isready
```

Expected evidence: - Executable paths resolve to the Termux
installation. - PostgreSQL reports that it is accepting connections.

### 15.4 Database login

``` bash
psql -h 127.0.0.1 -U forgequeue_user -d forgequeue -W
```

Then:

``` sql
SELECT current_user, current_database();
```

Expected values:

``` text
forgequeue_user
forgequeue
```

### 15.5 Project toolchain

Run from `~/projects/forgequeue`:

``` bash
npx tsc --version
npx tsx --version
npx vitest --version
npx tsc --showConfig
```

The TypeScript version should resolve to the pinned `5.9.3`. Record the
actual `tsx` and Vitest versions from the local installation rather than
assuming them.

### 15.6 Build and runtime

``` bash
npm run build
npm start
```

A successful build should exit without TypeScript errors and produce the
configured output under `dist/`. Runtime success should be verified
separately by observing the server process and making an HTTP request to
the configured route.

No HTTP response, port, or successful automated test result is asserted
here unless it has been observed separately.

------------------------------------------------------------------------

## 16. Phase 2 completion summary

### Completed

-   Established the Android + Termux development environment.
-   Set up Ubuntu 26.04.1 LTS through `proot-distro` for Linux-userland
    work.
-   Diagnosed the Termux/Ubuntu executable-path confusion.
-   Investigated Ubuntu PostgreSQL installation and cluster startup.
-   Identified the PRoot ownership limitation affecting the Ubuntu
    PostgreSQL cluster path.
-   Selected Termux-native PostgreSQL 18.6 and started it successfully.
-   Created the `forgequeue` database and `forgequeue_user` role;
    confirmed database ownership.
-   Initialized the ForgeQueue Git repository and npm project.
-   Installed the production and development dependency sets.
-   Pinned TypeScript to 5.9.3 for the current Android ARM64
    compatibility constraint.
-   Configured `.gitignore`, `tsconfig.json`, package metadata, and npm
    scripts.
-   Established the initial TypeScript entry point and Express
    health-route work.

### Not completed

-   Application-level PostgreSQL connectivity.
-   Environment-variable configuration for the database.
-   Database pool and readiness integration.
-   Schema, migrations, and automated tests.
-   Job submission and durable job-processing behavior.

### Current project status

ForgeQueue has a working local development foundation and a local
PostgreSQL server/database. It is not yet a database-integrated job
processing platform. The next implementation should connect the Express
application to PostgreSQL through a small, centralized connection-pool
module, with configuration loaded from environment variables and secrets
kept out of Git.

### Next planned implementation step

Implement the database configuration boundary and PostgreSQL connection
pool:

1.  Define the required environment variable names.
2.  Add a safe `.env.example` without real credentials.
3.  Load local `.env` configuration at application startup.
4.  Create a single `pg.Pool` module.
5.  Verify connectivity with a minimal query.
6.  Add a database-aware readiness check only after the pool is working.

Do not start the job submission API until database connectivity and its
failure behavior are verified.
