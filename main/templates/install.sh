if [ -z "$SERVER_ID" ] || [ -z "$SECRET" ]; then echo "错误: 缺少参数。"; exit 1; fi
echo "开始安装强力脱钩・秒级热重载探针 Agent..."

cat << 'EOF' > /usr/local/bin/cf-probe.sh
#!/bin/bash
SERVER_ID="{{SERVER_ID}}"
SECRET="{{SECRET}}"
WORKER_URL="{{WORKER_URL}}"
STATIC_URL="{{STATIC_URL}}"

get_net_bytes() { awk 'NR>2 {rx+=$2; tx+=$10} END {printf "%.0f %.0f", rx, tx}' /proc/net/dev; }
get_cpu_stat() { awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8+$9, $5+6}' /proc/stat; }
get_http_ping() { rtt=(curl -o /dev/null -s -m 2 -w "%{time_total}" "http://$1" 2>/dev/null | awk '{printf "%.0f", 1*1000}'); echo "{rtt:-0}"; }

NET_STAT=(getn​etb​ytes)RXP​REV=(echo $NET_STAT | awk '{print 1}')
TX_PREV=(echo NET_STAT | awk '{print $2}')
CPU_STAT=$(get_cpu_stat)
PREV_CPU_TOTAL=(echo $CPU_STAT | awk '{print 1}')
PREV_CPU_IDLE=(echo $CPU_STAT | awk '{print $2}')

LOOP_COUNT=0
IPV4="0"; IPV6="0"
PING_CT="0"; PING_CU="0"; PING_CM="0"; PING_BD="0"

REPORT_INTERVAL="{{REPORT_INTERVAL}}"
PING_NODE_CT="{{PING_NODE_CT}}"; PING_NODE_CU="{{PING_NODE_CU}}"; PING_NODE_CM="{{PING_NODE_CM}}"

LAST_CONFIG_TIME=0
LAST_REPORT_TIME=0
PREV_CPU_VAL=0; PREV_RAM_VAL=0; PREV_DISK_VAL=0
PREV_V4_STATE="X"; PREV_V6_STATE="X"

while true; do
NOW=$(date +%s)
if [ ((NOW−LASTC​ONFIGT​IME))−ge15];thenRESS​TATIC=(curl -s -m 3 "$STATIC_URL" 2>/dev/null)
if echo "RESS​TATIC"∣grep−q"INTERVAL";thenNEWI​NV=(echo "$RES_STATIC" | sed -n 's/."INTERVAL":[0−9]∗./\1/p')
if [ -n "$NEW_INV" ] && [ "$NEW_INV" -gt 0 ] 2>/dev/null; then REPORT_INTERVAL=$NEW_INV; fi
fi
LAST_CONFIG_TIME=$NOW
fi

if [ $((LOOP_COUNT % 12)) -eq 0 ]; then
curl -s -4 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV4="1" || IPV4="0"
curl -s -6 -m 3 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -q "ip=" && IPV6="1" || IPV6="0"
fi

if [ ((LOOPC​OUNTidx=((LOOP_COUNT % 3))
case $idx in
0) D_CT="bj-ct-dualstack.ip.zstaticcdn.com"; D_CU="bj-cu-dualstack.ip.zstaticcdn.com"; D_CM="bj-cm-dualstack.ip.zstaticcdn.com" ;;
1) D_CT="sh-ct-dualstack.ip.zstaticcdn.com"; D_CU="sh-cu-dualstack.ip.zstaticcdn.com"; D_CM="sh-cm-dualstack.ip.zstaticcdn.com" ;;
2) D_CT="gd-ct-dualstack.ip.zstaticcdn.com"; D_CU="gd-cu-dualstack.ip.zstaticcdn.com"; D_CM="gd-cm-dualstack.ip.zstaticcdn.com" ;;
esac
CT_NODE="$PING_NODE_CT"; CU_NODE="$PING_NODE_CU"; CM_NODE="$PING_NODE_CM"
[ "$CT_NODE" = "default" ] && CT_NODE="$D_CT"
[ "$CU_NODE" = "default" ] && CU_NODE="$D_CU"
[ "$CM_NODE" = "default" ] && CM_NODE="$D_CM"

PING_CT=$(get_http_ping "$CT_NODE")
PING_CU=$(get_http_ping "$CU_NODE")
PING_CM=$(get_http_ping "$CM_NODE")
PING_BD=$(get_http_ping "lf3-ips.zstaticcdn.com")

fi

LOOP_COUNT=((LOOPC​OUNT+1))OS=(awk -F= '/^PRETTY_NAME/{print 2}' /etc/os-release 2>/dev/null | tr -d '"')
[ -z "$OS" ] && OS=$(uname -srm)
ARCH=(uname -m)
BOOT_TIME=(uptime−s2>/dev/null∣∣echo"Unknown")CPUI​NFO=(grep -m 1 'model name' /proc/cpuinfo | awk -F: '{print 2}' | xargs | tr -d '"')
VIRT="Unknown"; command -v systemd-detect-virt >/dev/null 2>&1 && VIRT=(systemd-detect-virt 2>/dev/null)

CPU_STAT=(getc​pus​tat)CPUT​OTAL=(echo CPU_STAT | awk '{print $1}')
CPU_IDLE=$(echo $CPU_STAT | awk '{print $2}')
DIFF_TOTAL=$((CPU_TOTAL - PREV_CPU_TOTAL))
DIFF_IDLE=$((CPU_IDLE - PREV_CPU_IDLE))
CPU=(awk -v t=$DIFF_TOTAL -v i=$DIFF_IDLE 'BEGIN {if (t<=0) print 0; else {pct=(1 - i/t)*100; printf "%.1f", pct}}')
PREV_CPU_TOTAL=$CPU_TOTAL; PREV_CPU_IDLE=$CPU_IDLE

MEM_INFO=(free−m2>/dev/null)RAMT​OTAL=(echo "$MEM_INFO" | awk '/Mem:/ {print 2}')
RAM_USED=(echo "$MEM_INFO" | awk '/Mem:/ {print 3}')
RAM=(awk "BEGIN {if($RAM_TOTAL>0) printf "%.1f", $RAM_USED/RAM_TOTAL * 100.0; else print 0}")
SWAP_TOTAL=(echo "$MEM_INFO" | awk '/Swap:/ {print 2}')
SWAP_USED=(echo "$MEM_INFO" | awk '/Swap:/ {print $3}')

DISK_INFO=$(df -m / 2>/dev/null | tail -n1 | awk '{print $2, $3, 5}')
DISK_TOTAL=(echo "$DISK_INFO" | awk '{print 1}')
DISK_USED=(echo "$DISK_INFO" | awk '{print 2}')
DISK=(echo "$DISK_INFO" | awk '{print $3}' | tr -d '%')

LOAD=(cat /proc/loadavg | awk '{print $1, $2, $3}')
UPTIME=$(uptime -p 2>/dev/null | sed 's/up //' || echo "N/A")
PROCESSES=$(ps -e 2>/dev/null | wc -l)
TCP_CONN=$(ss -ant 2>/dev/null | wc -l)
UDP_CONN=(ss -anu 2>/dev/null | wc -l)

NET_STAT=(getn​etb​ytes)RXN​OW=(echo $NET_STAT | awk '{print 1}')
TX_NOW=(echo NET_STAT | awk '{print $2}')
RX_SPEED=$(((RX_NOW - RX_PREV) / 5))
TX_SPEED=(((TX_NOW - TX_PREV) / 5))
RX_PREV=$RX_NOW; TX_PREV=$TX_NOW

NEED_REPORT=0
if [ $((NOW - LAST_REPORT_TIME)) -ge $REPORT_INTERVAL ]; then NEED_REPORT=1; fi

CPU_DIFF=$(awk "BEGIN {d=$CPU-PREV_CPU_VAL; print (d<0?-d:d)}")
RAM_DIFF=(awk "BEGIN {d=$RAM-PREV_RAM_VAL; print (d<0?-d:d)}")
DISK_DIFF=(awk "BEGIN {d=$DISK-$PREV_DISK_VAL; print (d<0?-d:d)}")

if [ $(awk "BEGIN {print ($CPU_DIFF > 10.0 ? 1 : 0)}") -eq 1 ]; then NEED_REPORT=1; fi
if [ $(awk "BEGIN {print ($RAM_DIFF > 10.0 ? 1 : 0)}") -eq 1 ]; then NEED_REPORT=1; fi
if [ $(awk "BEGIN {print ($DISK_DIFF > 10.0 ? 1 : 0)}") -eq 1 ]; then NEED_REPORT=1; fi
if [ "$IPV4" != "$PREV_V4_STATE" ] || [ "$IPV6" != "$PREV_V6_STATE" ]; then NEED_REPORT=1; fi

if [ $NEED_REPORT -eq 1 ]; then
PAYLOAD="{"id": "$SERVER_ID", "secret": "$SECRET", "metrics": { "cpu": "$CPU", "ram": "$RAM", "ram_total": "$RAM_TOTAL", "ram_used": "$RAM_USED", "swap_total": "$SWAP_TOTAL", "swap_used": "$SWAP_USED", "disk": "$DISK", "disk_total": "$DISK_TOTAL", "disk_used": "$DISK_USED", "load": "$LOAD", "uptime": "$UPTIME", "boot_time": "$BOOT_TIME", "net_rx": "$RX_NOW", "net_tx": "$TX_NOW", "net_in_speed": "$RX_SPEED", "net_out_speed": "$TX_SPEED", "os": "$OS", "arch": "$ARCH", "cpu_info": "$CPU_INFO", "processes": "$PROCESSES", "tcp_conn": "$TCP_CONN", "udp_conn": "$UDP_CONN", "ip_v4": "$IPV4", "ip_v6": "$IPV6", "ping_ct": "$PING_CT", "ping_cu": "$PING_CU", "ping_cm": "$PING_CM", "ping_bd": "$PING_BD", "virt": "$VIRT" }}"
curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$WORKER_URL" > /dev/null 2>&1
LAST_REPORT_TIME=$NOW
PREV_CPU_VAL=$CPU; PREV_RAM_VAL=$RAM; PREV_DISK_VAL=$DISK
PREV_V4_STATE=$IPV4; PREV_V6_STATE=$IPV6
elif [ $((NOW - LAST_REPORT_TIME)) -ge 180 ]; then
PAYLOAD="{"id": "$SERVER_ID", "secret": "$SECRET", "type": "ping"}"
curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$WORKER_URL" > /dev/null 2>&1
LAST_REPORT_TIME=$NOW
fi
sleep 5
done
EOF
chmod +x /usr/local/bin/cf-probe.sh
