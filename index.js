const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// --- CONFIGURATION ---
const DATA_DIR = './data';
const OUTPUT_FILE = 'output.csv';
const MAX_RESTARTS = 30;
const DAILY_MAX_PERIODS = 10; // ⛔️ Strict Limit

// --- GLOBAL STATE ---
const db = {
    teachers: [], rooms: [], groups: [], subjects: [], teaches: [], timeslots: [], registers: []
};

const FILE_TO_KEY = {
    'teacher': 'teachers', 'room': 'rooms', 'student_group': 'groups', 'subject': 'subjects',
    'teach': 'teaches', 'timeslot': 'timeslots', 'register': 'registers'
};

const readCSV = (fileName) => {
    return new Promise((resolve, reject) => {
        const results = [];
        const filePath = path.join(DATA_DIR, `${fileName}.csv`);
        if (!fs.existsSync(filePath)) { console.error(`Error: File not found: ${filePath}`); process.exit(1); }
        fs.createReadStream(filePath)
            .pipe(csv({ mapHeaders: ({ header }) => header.trim().replace(/^\uFEFF/, '') }))
            .on('data', (data) => {
                const cleanData = {};
                Object.keys(data).forEach(key => cleanData[key] = data[key] ? data[key].trim() : '');
                results.push(cleanData);
            })
            .on('end', () => resolve(results))
            .on('error', (err) => reject(err));
    });
};

async function main() {
    console.log(`🚀 Starting Scheduler (Spread Days & Strict Max ${DAILY_MAX_PERIODS})...`);

    try {
        for (const file of Object.keys(FILE_TO_KEY)) db[FILE_TO_KEY[file]] = await readCSV(file);
        console.log(`✅ Data loaded.`);
    } catch (error) { console.error(error); return; }

    // Pre-processing
    const subjectMap = {};
    db.subjects.forEach(s => { if(s.subject_id) subjectMap[s.subject_id] = s; });

    const groupSizeMap = {};
    db.groups.forEach(g => {
        groupSizeMap[g.group_id] = parseInt(g.size) || Math.floor(Math.random() * 20) + 20;
    });

    const teacherExpertise = {};
    db.teaches.forEach(t => {
        if (!teacherExpertise[t.subject_id]) teacherExpertise[t.subject_id] = [];
        teacherExpertise[t.subject_id].push(t.teacher_id);
    });

    // Timeslot Helpers
    const timeslotMap = {};
    const validTimeslots = [];
    const slotsByDay = {}; 

    db.timeslots.forEach(t => {
        const p = parseInt(t.period);
        if (p === 5) return; // Skip Lunch
        
        timeslotMap[t.timeslot_id] = t;
        validTimeslots.push(t.timeslot_id);

        if (!slotsByDay[t.day]) slotsByDay[t.day] = [];
        slotsByDay[t.day].push({ id: t.timeslot_id, period: p });
    });

    Object.keys(slotsByDay).forEach(day => {
        slotsByDay[day].sort((a, b) => a.period - b.period);
    });

    // Identify Subjects
    const specialSubjectIds = new Set();
    const generalSubjectIds = new Set(); 

    db.subjects.forEach(s => {
        const id = s.subject_id || "";
        const name = s.subject_name || "";
        if (name.includes("ส่งเสริม") || name.includes("คุณธรรม") || name.includes("องค์การวิชาชีพ") || name.includes("จริยธรรม")) {
            specialSubjectIds.add(id);
        } else if (id.startsWith("20000") || id.startsWith("30000")) {
            generalSubjectIds.add(id);
        }
    });

    // Wednesday Fixed Slots
    const wedSlot8 = db.timeslots.find(t => t.day === 'Wed' && parseInt(t.period) === 8);
    const wedSlot9 = db.timeslots.find(t => t.day === 'Wed' && parseInt(t.period) === 9);
    const fixedActivitySlots = (wedSlot8 && wedSlot9) ? [wedSlot8.timeslot_id, wedSlot9.timeslot_id] : [];

    // --- MERGING LOGIC ---
    console.log("🔄 Merging groups...");
    const subjectRegistry = {};
    db.registers.forEach(reg => {
        if (!subjectRegistry[reg.subject_id]) subjectRegistry[reg.subject_id] = [];
        subjectRegistry[reg.subject_id].push(reg.group_id);
    });

    let allSessions = [];

    Object.keys(subjectRegistry).forEach(subjId => {
        const groupsTaking = subjectRegistry[subjId];
        const sub = subjectMap[subjId];
        const totalPeriods = (parseInt(sub.theory)||0) + (parseInt(sub.practice)||0);
        
        let finalGroups = [];

        if (generalSubjectIds.has(subjId) && groupsTaking.length >= 2) {
            groupsTaking.sort((a, b) => groupSizeMap[a] - groupSizeMap[b]);
            const used = new Set();
            for (let i = 0; i < groupsTaking.length; i++) {
                if (used.has(i)) continue;
                if (i + 1 < groupsTaking.length) {
                    finalGroups.push(`${groupsTaking[i]}+${groupsTaking[i+1]}`); 
                    used.add(i); used.add(i+1);
                } else {
                    finalGroups.push(groupsTaking[i]);
                    used.add(i);
                }
            }
        } else {
            finalGroups = groupsTaking;
        }

        finalGroups.forEach(compositeGroupId => {
            for (let i = 0; i < totalPeriods; i++) {
                allSessions.push({
                    groupId: compositeGroupId,
                    subjectId: subjId,
                    id: `${compositeGroupId}-${subjId}-${i}`,
                    isSpecial: specialSubjectIds.has(subjId),
                    seqIndex: i
                });
            }
        });
    });

    console.log(`📋 Total Periods: ${allSessions.length}`);

    // --- SCHEDULING ---
    let bestSchedule = null;
    let minConflicts = Infinity;

    for (let attempt = 1; attempt <= MAX_RESTARTS; attempt++) {
        const specialSessions = allSessions.filter(s => s.isSpecial);
        const normalSessions = allSessions.filter(s => !s.isSpecial);
        
        const bundles = {}; 
        normalSessions.forEach(s => {
            const key = `${s.groupId}|${s.subjectId}`;
            if (!bundles[key]) bundles[key] = [];
            bundles[key].push(s);
        });
        const bundleList = Object.values(bundles).sort(() => 0.5 - Math.random()); 

        const result = runScheduleAttempt(specialSessions, bundleList, validTimeslots, teacherExpertise, timeslotMap, fixedActivitySlots, slotsByDay, db.rooms.map(r=>r.room_id));
        
        if (result.unassigned.length === 0) {
            console.log(`✨ Solution found at attempt #${attempt}`);
            bestSchedule = result.assignments;
            break;
        } else {
            if (result.unassigned.length < minConflicts) {
                minConflicts = result.unassigned.length;
                bestSchedule = result.assignments;
            }
        }
    }

    if (bestSchedule) generateCSV(bestSchedule, timeslotMap);
    else console.error("❌ No complete solution found.");
}

function runScheduleAttempt(specialSessions, bundleList, validTimeslots, teacherExpertise, timeslotMap, fixedActivitySlots, slotsByDay, rooms) {
    const assignments = [];
    const unassigned = [];
    
    const slotState = {}; 
    validTimeslots.forEach(tid => {
        slotState[tid] = { groups: new Set(), teachers: new Set(), rooms: new Set() };
    });
    
    const dailyLoad = {}; // Track periods per day
    const activityTeacherRoomMap = {}; 

    // --- PHASE 1: SPECIAL (Wed 8-9) ---
    for (const sess of specialSessions) {
        if (fixedActivitySlots.length === 0) { unassigned.push(sess); continue; }
        const individualGroups = sess.groupId.split('+');
        const teachers = teacherExpertise[sess.subjectId];
        const chosenTeacher = (teachers && teachers.length > 0) ? teachers[0] : 'T_UNKNOWN';
        const targetTid = fixedActivitySlots[sess.seqIndex % 2]; 

        let chosenRoom = null;
        if (activityTeacherRoomMap[chosenTeacher]) {
            chosenRoom = activityTeacherRoomMap[chosenTeacher];
        } else {
            const usedRooms = new Set(Object.values(activityTeacherRoomMap));
            const availableRooms = rooms.filter(r => !usedRooms.has(r));
            if (availableRooms.length > 0) {
                chosenRoom = availableRooms[Math.floor(Math.random() * availableRooms.length)];
                activityTeacherRoomMap[chosenTeacher] = chosenRoom;
            } else { unassigned.push(sess); continue; }
        }

        const state = slotState[targetTid];
        let conflict = false;
        individualGroups.forEach(g => {
            if (state.groups.has(g)) conflict = true;
            // Activity counts towards daily limit
            if ((dailyLoad[`${g}|Wed`] || 0) >= DAILY_MAX_PERIODS) conflict = true;
        });
        
        if (conflict) { unassigned.push(sess); continue; }

        assignments.push({ group_id: sess.groupId, timeslot_id: targetTid, subject_id: sess.subjectId, teacher_id: chosenTeacher, room_id: chosenRoom });
        
        individualGroups.forEach(g => {
            state.groups.add(g);
            dailyLoad[`${g}|Wed`] = (dailyLoad[`${g}|Wed`] || 0) + 1;
        });
        state.teachers.add(chosenTeacher);
        state.rooms.add(chosenRoom);
    }

    // --- PHASE 2: NORMAL (Spread Days + Consecutive) ---
    for (const bundle of bundleList) {
        const individualGroups = bundle[0].groupId.split('+');
        const teachers = teacherExpertise[bundle[0].subjectId] || [];
        if (teachers.length === 0) { unassigned.push(...bundle); continue; }

        let pending = [...bundle];
        
        while (pending.length > 0) {
            let placed = false;
            
            for (let size = pending.length; size >= 1; size--) {
                const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
                
                // *** SMART SORTING: เลือกวันที่ "งานน้อยที่สุด" ก่อน (Load Balancing) ***
                // เพื่อให้กระจายการเรียนไปทุกวัน
                days.sort((a, b) => {
                    let loadA = 0;
                    let loadB = 0;
                    individualGroups.forEach(g => {
                        loadA += (dailyLoad[`${g}|${a}`] || 0);
                        loadB += (dailyLoad[`${g}|${b}`] || 0);
                    });
                    return loadA - loadB; // น้อยไปมาก
                });

                for (const day of days) {
                    if (placed) break;
                    
                    const daySlots = slotsByDay[day] || [];
                    const usableSlots = daySlots.filter(s => {
                        return !(day === 'Wed' && (s.period === 8 || s.period === 9));
                    });

                    for (let i = 0; i <= usableSlots.length - size; i++) {
                        // 1. Check Consecutive
                        let isConsecutive = true;
                        for (let k = 0; k < size - 1; k++) {
                            if (usableSlots[i+k+1].period !== usableSlots[i+k].period + 1) {
                                isConsecutive = false; break;
                            }
                        }
                        if (!isConsecutive) continue;

                        const candidateTids = [];
                        for (let k = 0; k < size; k++) candidateTids.push(usableSlots[i+k].id);

                        // 2. Check Limits & Conflicts
                        let blockValid = true;
                        individualGroups.forEach(g => {
                            if ((dailyLoad[`${g}|${day}`] || 0) + size > DAILY_MAX_PERIODS) blockValid = false;
                        });
                        if (!blockValid) continue;

                        for (const tid of candidateTids) {
                            const st = slotState[tid];
                            individualGroups.forEach(g => { if (st.groups.has(g)) blockValid = false; });
                        }
                        if (!blockValid) continue;

                        // 3. Resources
                        let chosenTeacher = null;
                        for (const t of teachers) {
                            let tOk = true;
                            for (const tid of candidateTids) { if (slotState[tid].teachers.has(t)) tOk = false; }
                            if (tOk) { chosenTeacher = t; break; }
                        }
                        if (!chosenTeacher) continue;

                        let chosenRoom = null;
                        const shuffledRooms = [...rooms].sort(() => 0.5 - Math.random());
                        for (const r of shuffledRooms) {
                            let rOk = true;
                            for (const tid of candidateTids) { if (slotState[tid].rooms.has(r)) rOk = false; }
                            if (rOk) { chosenRoom = r; break; }
                        }
                        if (!chosenRoom) continue;

                        // Assign
                        for (let k = 0; k < size; k++) {
                            const session = pending[k];
                            const tid = candidateTids[k];
                            
                            assignments.push({
                                group_id: session.groupId,
                                timeslot_id: tid,
                                subject_id: session.subjectId,
                                teacher_id: chosenTeacher,
                                room_id: chosenRoom
                            });

                            const st = slotState[tid];
                            individualGroups.forEach(g => st.groups.add(g));
                            st.teachers.add(chosenTeacher);
                            st.rooms.add(chosenRoom);
                        }
                        
                        individualGroups.forEach(g => {
                            dailyLoad[`${g}|${day}`] = (dailyLoad[`${g}|${day}`] || 0) + size;
                        });

                        pending = pending.slice(size);
                        placed = true;
                        break; 
                    }
                }
                if (placed) break;
            }

            if (!placed) {
                unassigned.push(...pending);
                break;
            }
        }
    }

    return { assignments, unassigned };
}

function generateCSV(assignments, timeslotMap) {
    const expandedAssignments = [];
    assignments.forEach(a => {
        const groups = a.group_id.split('+');
        groups.forEach(g => {
            expandedAssignments.push({ ...a, group_id: g });
        });
    });

    expandedAssignments.sort((a, b) => {
        if (a.group_id !== b.group_id) return a.group_id.localeCompare(b.group_id);
        return parseInt(a.timeslot_id) - parseInt(b.timeslot_id);
    });

    const header = 'group_id,timeslot_id,day,period,subject_id,teacher_id,room_id';
    const rows = expandedAssignments.map(a => {
        const ts = timeslotMap[a.timeslot_id];
        return `${a.group_id},${a.timeslot_id},${ts.day},${ts.period},${a.subject_id},${a.teacher_id},${a.room_id}`;
    });

    const content = [header, ...rows].join('\n');
    fs.writeFileSync(OUTPUT_FILE, content);
    console.log(`\n💾 Schedule exported to ${OUTPUT_FILE}`);
    console.log(`📊 Total Classes Scheduled: ${expandedAssignments.length}`);
}

main();