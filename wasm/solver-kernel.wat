;; solver-kernel.wat — Hot-path kernel for the profession solver.
;;
;; This is the REVIEWABLE SOURCE of the WebAssembly kernel used by
;; solver-worker.js. It is compiled to solver-kernel.wasm by
;; `node scripts/build-wasm.js` (npm run build:wasm). CI rebuilds this file and
;; fails if the committed solver-kernel.wasm does not match, so the binary can
;; never drift from this source.
;;
;; It implements countValid: given a candidate stat total and the set of
;; professions (humans) in a sparse layout, count how many professions are
;; satisfied (every required stat met or exceeded). This runs at essentially
;; every node of the search, so it is the single hottest operation.
;;
;; Memory layout (set up by solver-worker.js wasmLoadHumans):
;;   bytes 0..119   : total[0..14]      15 x f64   (the candidate stat vector)
;;   $ho            : (nHumans+1) x i32  start index (in entries) of each human
;;   $hstat         : nEntries x i32     stat index of each sparse requirement
;;   $hval          : nEntries x f64     required value of each sparse requirement
;;
;; countValid(ho, hstat, hval, n, cap) -> i32
;;   ho, hstat, hval : byte offsets of the three arrays above
;;   n               : number of professions (humans)
;;   cap             : if > 0, early-exit and return cap as soon as `cap`
;;                     professions match (used by the collateral lower-bound
;;                     prune, which only needs to know "are there already >= cap
;;                     matches?"). cap = 0 means count them all.
(module
  (memory (export "mem") 64)  ;; 64 pages = 4 MiB linear memory

  (func (export "countValid")
        (param $ho i32) (param $hstat i32) (param $hval i32) (param $n i32) (param $cap i32)
        (result i32)
    (local $h i32)      ;; current human index
    (local $count i32)  ;; professions satisfied so far
    (local $start i32)  ;; first sparse-entry index for this human
    (local $end i32)    ;; one-past-last sparse-entry index for this human
    (local $k i32)      ;; current sparse-entry index
    (local $valid i32)  ;; 1 while this human is still fully satisfied
    (local $si i32)     ;; stat index of the current requirement

    (block $hdone
      (loop $hloop
        (br_if $hdone (i32.ge_s (local.get $h) (local.get $n)))

        ;; start = ho[h], end = ho[h+1]  (i32 array, 4 bytes per element)
        (local.set $start
          (i32.load (i32.add (local.get $ho) (i32.mul (local.get $h) (i32.const 4)))))
        (local.set $end
          (i32.load (i32.add (local.get $ho)
            (i32.mul (i32.add (local.get $h) (i32.const 1)) (i32.const 4)))))

        (local.set $valid (i32.const 1))
        (local.set $k (local.get $start))

        ;; For each required stat of this human, check total[si] >= reqValue.
        (block $kdone
          (loop $kloop
            (br_if $kdone (i32.ge_s (local.get $k) (local.get $end)))

            ;; si = hstat[k]  (i32 array)
            (local.set $si
              (i32.load (i32.add (local.get $hstat) (i32.mul (local.get $k) (i32.const 4)))))

            ;; if total[si] < hval[k] -> this human fails, stop scanning it.
            ;;   total[si] is at byte si*8; hval[k] is at byte hval + k*8.
            (if (f64.lt
                  (f64.load (i32.mul (local.get $si) (i32.const 8)))
                  (f64.load (i32.add (local.get $hval) (i32.mul (local.get $k) (i32.const 8)))))
              (then
                (local.set $valid (i32.const 0))
                (br $kdone)))

            (local.set $k (i32.add (local.get $k) (i32.const 1)))
            (br $kloop)))

        ;; If every requirement was met, count this profession.
        (if (local.get $valid)
          (then
            (local.set $count (i32.add (local.get $count) (i32.const 1)))
            ;; Early exit when cap > 0 and we've reached cap matches.
            (if (i32.and
                  (i32.gt_s (local.get $cap) (i32.const 0))
                  (i32.ge_s (local.get $count) (local.get $cap)))
              (then (br $hdone)))))

        (local.set $h (i32.add (local.get $h) (i32.const 1)))
        (br $hloop)))

    (local.get $count)))
