# Launch Radar — token-radar-01 entry.
# The grader runs main.ts itself (Node 22, standard library only); these targets are for local work.

SNAPSHOT ?= ../token-radar-01-kit/input/snapshot.json

.PHONY: run out check-size clean
run:
	node main.ts --input $(SNAPSHOT)

out:
	mkdir -p out
	MAKEFUN_OUTPUT_DIR=out node main.ts --input $(SNAPSHOT)

check-size:
	@wc -c dashboard/index.html dashboard/app.css dashboard/app.js
	@ls -la screenshots/

clean:
	rm -rf out out2
