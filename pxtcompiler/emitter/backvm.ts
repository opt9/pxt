namespace ts.pxtc {
    const vmSpecOpcodes: pxt.Map<string> = {
        /*
        "Number_::eq": "eq",
        "Number_::adds": "add",
        "Number_::subs": "sub",
        */
    }

    const vmCallMap: pxt.Map<string> = {
    }

    function shimToVM(shimName: string) {
        return shimName
    }

    function qs(s: string) {
        return JSON.stringify(s)
    }

    function vtableToVM(info: ClassInfo, opts: CompileOptions, bin: Binary) {
        /*
        uint16_t numbytes;
        ValType objectType;
        uint8_t magic;
        uint32_t padding;
        PVoid *ifaceTable;
        BuiltInType classNo;
        uint16_t reserved;
        uint32_t ifaceHashMult;
        uint32_t padding;
        PVoid methods[2 or 4];
        */

        const ifaceInfo = computeHashMultiplier(info.itable.map(e => e.idx))
        //if (info.itable.length == 0)
        //    ifaceInfo.mult = 0

        const mapping = U.toArray(ifaceInfo.mapping)

        while (mapping.length & 3)
            mapping.push(0)

        let s = `
${info.id}_VT_start:
        .short ${info.allfields.length * 4 + 4}  ; size in bytes
        .byte ${pxt.ValTypeObject}, ${pxt.VTABLE_MAGIC} ; magic
        .word ${mapping.length} ; entries in iface hashmap
        .word ${info.id}_IfaceVT-${info.id}_VT_start, 0
        .short ${info.classNo} ; class-id
        .short 0 ; reserved
        .word ${ifaceInfo.mult} ; hash-mult
        .word 0,0, 0,0, 0,0, 0,0 ; space for 4 native methods
`;

        let addPtr = (n: string) => {
            if (n != "0") n += "@fn"
            s += `        .word ${n}\n`
        }

        let toStr = info.toStringMethod
        addPtr(toStr ? toStr.vtLabel() : "0")

        for (let m of info.vtable) {
            addPtr(m.label())
        }

        s += `
        .balign 4
${info.id}_IfaceVT:
`

        const descSize = 1
        const zeroOffset = mapping.length >> 2

        let descs = ""
        let offset = zeroOffset
        let offsets: pxt.Map<number> = {}
        for (let e of info.itable) {
            offsets[e.idx + ""] = offset
            descs += `  .short ${e.idx}, ${e.info} ; ${e.name}\n`
            descs += `  .word ${e.proc ? e.proc.vtLabel() + "@fn" : e.info}\n`
            offset += descSize
            if (e.setProc) {
                descs += `  .short ${e.idx}, 0 ; set ${e.name}\n`
                descs += `  .word ${e.setProc.vtLabel()}@fn\n`
                offset += descSize
            }
        }

        descs += "  .word 0, 0 ; the end\n"
        offset += descSize

        for (let i = 0; i < mapping.length; ++i) {
            bin.itEntries++
            if (mapping[i])
                bin.itFullEntries++
        }

        s += "  .short " + U.toArray(mapping).map((e, i) => offsets[e + ""] || zeroOffset).join(", ") + "\n"
        s += descs

        s += "\n"
        return s
    }

    // keep in sync with vm.h
    enum SectionType {
        Invalid = 0x00,

        // singular sections
        InfoHeader = 0x01,       // VMImageHeader
        OpCodeMap = 0x02,        // \0-terminated names of opcodes and APIs (shims)
        NumberLiterals = 0x03,   // array of boxed doubles and ints
        ConfigData = 0x04,       // sorted array of pairs of int32s; zero-terminated
        IfaceMemberNames = 0x05, // array of 32 bit offsets, that point to string literals
        VCallInfos = 0x06,       // array of pairs of offset (32b), method index (32b)

        // repetitive sections
        Function = 0x20,
        Literal = 0x21, // aux field contains literal type (string, hex, image, ...)
        VTable = 0x22,
    }

    /* tslint:disable:no-trailing-whitespace */
    export function vmEmit(bin: Binary, opts: CompileOptions) {
        let vmsource = `; VM start
${hex.hexPrelude()}
`

        const ctx: EmitCtx = {
            dblText: [],
            dbls: {},
            opcodeMap: {},
            opcodes: vm.opcodes.map(o => "pxt::op_" + o.replace(/ .*/, "")),
            vcallMap: {},
            vcallText: [],
        }

        ctx.opcodes.unshift(null)
        while (ctx.opcodes.length < 128)
            ctx.opcodes.push(null)

        let address = 0
        function section(name: string, tp: SectionType, body: () => string, aliases?: string[], aux = 0) {
            vmsource += `
; --- ${name}
.section code
    .set ${name} = ${address}
`
            if (aliases) {
                for (let alias of aliases)
                    vmsource += `    .set ${alias} = ${address}\n`
            }
            vmsource += `
_start_${name}:
    .byte ${tp}, 0x00
    .short ${aux}
    .word _end_${name}-_start_${name}\n`
            vmsource += body()
            vmsource += `\n.balign 8\n_end_${name}:\n`
            address++
        }

        section("_info", SectionType.InfoHeader, () => `
                ; magic - \\0 added by assembler
                .string "\\nPXT64\\n"
                .hex 5471fe2b5e213768 ; magic
                .hex ${hex.hexTemplateHash()} ; hex template hash
                .hex 0000000000000000 ; @SRCHASH@
                .word ${bin.globalsWords}   ; num. globals
                .word ${bin.nonPtrGlobals} ; non-ptr globals
`
        )
        bin.procs.forEach(p => {
            section(p.label(), SectionType.Function, () => irToVM(ctx, bin, p),
                [p.label() + "_Lit"])
        })
        vmsource += "_code_end:\n\n"
        vmsource += "_helpers_end:\n\n"
        bin.usedClassInfos.forEach(info => {
            section(info.id + "_VT", SectionType.VTable, () => vtableToVM(info, opts, bin))
        })

        let idx = 0
        section("ifaceMemberNames", SectionType.IfaceMemberNames, () => bin.ifaceMembers.map(d =>
            `    .word ${bin.emitString(d)}  ; ${idx++} .${d}`
        ).join("\n"))

        vmsource += "_vtables_end:\n\n"

        U.iterMap(bin.hexlits, (k, v) => {
            section(v, SectionType.Literal, () => hexLiteralAsm(k), [], pxt.BuiltInType.BoxedBuffer)
        })
        U.iterMap(bin.strings, (k, v) => {
            section(v, SectionType.Literal, () => `.word ${k.length}\n.utf16 ${JSON.stringify(k)}`, [], pxt.BuiltInType.BoxedString)
        })
        section("numberLiterals", SectionType.NumberLiterals, () => ctx.dblText.join("\n"))
        section("vcallInfo", SectionType.VCallInfos, () => ctx.vcallText.join("\n"))

        const cfg = bin.res.configData || []
        section("configData", SectionType.ConfigData, () => cfg.map(d =>
            `    .word ${d.key}, ${d.value}  ; ${d.name}=${d.value}`).join("\n")
            + "\n    .word 0, 0")

        let s = ctx.opcodes.map(s => s == null ? "" : s).join("\0") + "\0"
        let opcm = ""
        while (s) {
            let pref = s.slice(0, 64)
            s = s.slice(64)
            if (pref.length & 1)
                pref += "\0"
            opcm += ".hex " + U.toHex(U.stringToUint8Array(pref)) + "\n"
        }
        section("opcodeMap", SectionType.OpCodeMap, () => opcm)
        vmsource += "_literals_end:\n"

        vmsource += "\n; The end.\n"
        bin.writeFile(BINARY_ASM, vmsource)

        let res = assemble(opts.target, bin, vmsource)
        if (res.src)
            bin.writeFile(pxtc.BINARY_ASM, res.src)

        /*
        let pc = res.thumbFile.peepCounts
        let keys = Object.keys(pc)
        keys.sort((a, b) => pc[b] - pc[a])
        for (let k of keys.slice(0, 50)) {
            console.log(`${k}  ${pc[k]}`)
        }
        */

        if (res.buf) {
            let binstring = ""
            for (let v of res.buf)
                binstring += String.fromCharCode(v & 0xff, v >> 8)
            const myhex = ts.pxtc.encodeBase64(binstring)
            bin.writeFile(pxt.outputName(target), myhex)
        }
    }
    /* tslint:enable */

    interface EmitCtx {
        dblText: string[]
        dbls: pxt.Map<number>
        opcodeMap: pxt.Map<number>;
        opcodes: string[];
        vcallText: string[];
        vcallMap: pxt.Map<number>;
    }


    function irToVM(ctx: EmitCtx, bin: Binary, proc: ir.Procedure): string {
        let resText = ""
        const writeRaw = (s: string) => { resText += s + "\n"; }
        const write = (s: string) => { resText += "    " + s + "\n"; }
        const EK = ir.EK;
        let alltmps: ir.Expr[] = []
        let currTmps: ir.Expr[] = []
        let final = false
        let numBrk = 0
        let numLoc = 0
        let argDepth = 0

        const immMax = (1 << 23) - 1

        //console.log(proc.toString())
        proc.resolve()
        // console.log("OPT", proc.toString())

        emitAll()
        bin.numStmts = numBrk
        resText = ""
        for (let t of alltmps) t.currUses = 0
        final = true
        U.assert(argDepth == 0)
        emitAll()

        return resText

        function emitAll() {
            writeRaw(`;\n; Proc: ${proc.getName()}\n;`)
            write(".section code")
            if (bin.procs[0] == proc) {
                writeRaw(`; main`)
            }

            write(`.short 0, ${proc.args.length}`)
            write(`.short ${proc.captured.length}, 0`)
            write(`.word 0, 0`) // space for fn pointer (64 bit)

            numLoc = proc.locals.length + currTmps.length
            write(`pushmany ${numLoc} ; incl. ${currTmps.length} tmps`)

            for (let s of proc.body) {
                switch (s.stmtKind) {
                    case ir.SK.Expr:
                        emitExpr(s.expr)
                        break;
                    case ir.SK.StackEmpty:
                        clearStack()
                        for (let e of currTmps) {
                            if (e) {
                                oops(`uses: ${e.currUses}/${e.totalUses} ${e.toString()}`);
                            }
                        }
                        break;
                    case ir.SK.Jmp:
                        emitJmp(s);
                        break;
                    case ir.SK.Label:
                        writeRaw(`${s.lblName}:`)
                        break;
                    case ir.SK.Breakpoint:
                        numBrk++
                        break;
                    default: oops();
                }
            }

            write(`ret ${proc.args.length}, ${numLoc}`)
        }

        function emitJmp(jmp: ir.Stmt) {
            let trg = jmp.lbl.lblName
            if (jmp.jmpMode == ir.JmpMode.Always) {
                if (jmp.expr)
                    emitExpr(jmp.expr)
                write(`jmp ${trg}`)
            } else {
                emitExpr(jmp.expr)
                if (jmp.jmpMode == ir.JmpMode.IfNotZero) {
                    write(`jmpnz ${trg}`)
                } else if (jmp.jmpMode == ir.JmpMode.IfZero) {
                    write(`jmpz ${trg}`)

                } else {
                    oops()
                }
            }
        }

        function cellref(cell: ir.Cell) {
            if (cell.isGlobal()) {
                U.assert((cell.index & 3) == 0)
                return (`glb ` + (cell.index >> 2))
            } else if (cell.iscap)
                return (`cap ` + cell.index)
            else if (cell.isarg) {
                let idx = proc.args.length - cell.index - 1
                assert(idx >= 0, "arg#" + idx)
                return (`loc ${argDepth + numLoc + 1 + idx}`)
            }
            else {
                let idx = cell.index + currTmps.length
                //console.log(proc.locals.length, currTmps.length, cell.index)
                assert(!final || idx < numLoc, "cell#" + idx)
                assert(idx >= 0, "cell#" + idx)
                return (`loc ${argDepth + idx}`)
            }
        }

        function callRT(name: string) {
            const inf = hex.lookupFunc(name)
            if (!inf) U.oops("missing function: " + name)
            let id = ctx.opcodeMap[inf.name]
            if (id == null) {
                id = ctx.opcodes.length
                ctx.opcodes.push(inf.name)
                ctx.opcodeMap[inf.name] = id
                inf.value = id
            }
            write(`callrt ${name}`)
        }

        function emitInstanceOf(info: ClassInfo, tp: string) {
            push()
            write(`ldint ${info.classNo}`)
            push()
            write(`ldint ${info.lastSubtypeNo}`)
            if (tp == "bool")
                callRT("pxt::instanceOf")
            else if (tp == "validate" || tp == "validateDecr") {
                callRT("pxt::validateInstanceOf")
            } else {
                U.oops()
            }
            argDepth -= 2
        }

        function emitExprInto(e: ir.Expr) {
            switch (e.exprKind) {
                case EK.NumberLiteral:
                    const tagged = taggedSpecial(e.data)
                    if (tagged != null)
                        write(`ldspecial ${tagged} ; ${e.data}`)
                    else {
                        let n = e.data as number
                        let n0 = 0, n1 = 0
                        if ((n | 0) == n) {
                            if (Math.abs(n) <= immMax) {
                                if (n < 0)
                                    write(`ldintneg ${-n}`)
                                else
                                    write(`ldint ${n}`)
                                return
                            } else {
                                n0 = ((n << 1) | 1) >>> 0
                                n1 = n < 0 ? 1 : 0
                            }
                        } else {
                            let a = new Float64Array(1)
                            a[0] = n
                            let u = new Uint32Array(a.buffer)
                            u[1] += 0x10000
                            n0 = u[0]
                            n1 = u[1]
                        }
                        let key = n0 + "," + n1
                        let id = U.lookup(ctx.dbls, key)
                        if (id == null) {
                            id = ctx.dblText.length
                            ctx.dblText.push(`.word ${n0}, ${n1}  ; ${id}: ${e.data}`)
                            ctx.dbls[key] = id
                        }
                        write(`ldnumber ${id} ; ${e.data}`)
                    }
                    return
                case EK.PointerLiteral:
                    write(`ldlit ${e.data}`)
                    return
                case EK.SharedRef:
                    let arg = e.args[0]
                    U.assert(!!arg.currUses) // not first use
                    U.assert(arg.currUses < arg.totalUses)
                    arg.currUses++
                    let idx = currTmps.indexOf(arg)
                    if (idx < 0) {
                        console.log(currTmps, arg)
                        assert(false)
                    }
                    write(`ldloc ${idx + argDepth}`)
                    clearStack()
                    return
                case EK.CellRef:
                    write("ld" + cellref(e.data))
                    let cell = e.data as ir.Cell
                    if (cell.isGlobal()) {
                        // TODO
                        if (cell.bitSize == BitSize.Int8) {
                            write(`sgnext`)
                        } else if (cell.bitSize == BitSize.UInt8) {
                            write(`clrhi`)
                        }
                    }
                    return
                case EK.InstanceOf:
                    emitExpr(e.args[0])
                    emitInstanceOf(e.data, e.jsInfo)
                    break

                default: throw oops("kind: " + e.exprKind);
            }
        }

        // result in R0
        function emitExpr(e: ir.Expr): void {
            //console.log(`EMITEXPR ${e.sharingInfo()} E: ${e.toString()}`)

            switch (e.exprKind) {
                case EK.JmpValue:
                    write("; jmp value (already in r0)")
                    break;
                case EK.Nop:
                    write("; nop")
                    break
                case EK.Incr:
                case EK.Decr:
                    U.oops()
                    break;
                case EK.FieldAccess:
                    let info = e.data as FieldAccessInfo
                    // it does the decr itself, no mask
                    return emitExpr(ir.rtcall("pxt::ldfld", [e.args[0], ir.numlit(info.idx)]))
                case EK.Store:
                    return emitStore(e.args[0], e.args[1])
                case EK.RuntimeCall:
                    return emitRtCall(e);
                case EK.ProcCall:
                    return emitProcCall(e)
                case EK.SharedDef:
                    return emitSharedDef(e)
                case EK.Sequence:
                    return e.args.forEach(emitExpr)
                default:
                    return emitExprInto(e)
            }
        }

        function emitSharedDef(e: ir.Expr) {
            let arg = e.args[0]
            U.assert(arg.totalUses >= 1)
            U.assert(arg.currUses === 0)
            arg.currUses = 1
            alltmps.push(arg)
            if (arg.totalUses == 1)
                return emitExpr(arg)
            else {
                emitExpr(arg)
                let idx = -1
                for (let i = 0; i < currTmps.length; ++i)
                    if (currTmps[i] == null) {
                        idx = i
                        break
                    }
                if (idx < 0) {
                    if (final) {
                        console.log(arg, currTmps)
                        assert(false, "missed tmp")
                    }
                    idx = currTmps.length
                    currTmps.push(arg)
                } else {
                    currTmps[idx] = arg
                }
                write(`stloc ${idx + argDepth}`)
            }
        }

        function push() {
            write(`push`)
            argDepth++
        }

        function emitRtCall(topExpr: ir.Expr) {
            let name: string = topExpr.data
            name = U.lookup(vmCallMap, name) || name

            clearStack()

            let spec = U.lookup(vmSpecOpcodes, name)
            let args = topExpr.args
            let numPush = 0

            for (let i = 0; i < args.length; ++i) {
                emitExpr(args[i])
                if (i < args.length - 1) {
                    push()
                    numPush++
                }
            }

            //let inf = hex.lookupFunc(name)

            if (name == "langsupp::ignore") {
                if (numPush)
                    write(`popmany ${numPush} ; ignore`)
            } else if (spec) {
                write(spec)
            } else {
                callRT(name)
            }

            argDepth -= numPush
        }


        function clearStack() {
            for (let i = 0; i < currTmps.length; ++i) {
                let e = currTmps[i]
                if (e && e.currUses == e.totalUses) {
                    if (!final)
                        alltmps.push(e)
                    currTmps[i] = null
                }
            }
        }


        function emitProcCall(topExpr: ir.Expr) {
            let calledProcId = topExpr.data as ir.ProcId
            let calledProc = calledProcId.proc

            let numPush = 0
            const args = topExpr.args.slice()
            const lambdaArg = calledProcId.virtualIndex == -1 ? args.shift() : null

            for (let e of args) {
                emitExpr(e)
                push()
                numPush++
            }

            let nargs = args.length

            if (lambdaArg) {
                emitExpr(lambdaArg)
                write(`callind ${nargs}`)
            } else if (calledProcId.ifaceIndex != null) {
                write(`calliface ${nargs}, ${calledProcId.ifaceIndex}`)
            } else if (calledProcId.virtualIndex != null) {
                if (!calledProcId.classInfo) console.log(calledProcId)
                let key = calledProcId.classInfo.id + "," + calledProcId.virtualIndex
                if (!ctx.vcallMap[key]) {
                    ctx.vcallMap[key] = ctx.vcallText.length
                    ctx.vcallText.push(`.word ${calledProcId.classInfo.id}_VT, ${calledProcId.virtualIndex}`)
                }
                write(`callmeth ${nargs}, ${ctx.vcallMap[key]}`)
            } else {
                write(`callproc ${calledProc.label()}`)
            }

            argDepth -= numPush
        }

        function emitStore(trg: ir.Expr, src: ir.Expr) {
            switch (trg.exprKind) {
                case EK.CellRef:
                    emitExpr(src)
                    let cell = trg.data as ir.Cell
                    let instr = "st" + cellref(cell)
                    if (cell.isGlobal() &&
                        (cell.bitSize == BitSize.Int8 || cell.bitSize == BitSize.UInt8)) {
                        instr = instr.replace("stglb", "stglb1")
                    }
                    write(instr)
                    break;
                case EK.FieldAccess:
                    let info = trg.data as FieldAccessInfo
                    // it does the decr itself, no mask
                    emitExpr(ir.rtcall("pxt::stfld", [trg.args[0], ir.numlit(info.idx), src]))
                    break;
                default: oops();
            }
        }
    }
}
