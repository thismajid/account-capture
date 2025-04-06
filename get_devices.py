import sys
import json
from psnawp_api import PSNAWP

def main():
    npsso = sys.argv[1]  # گرفتن npsso از آرگومان

    psnawp = PSNAWP(npsso)
    client = psnawp.me()
    devices = client.get_account_devices()

    print(json.dumps(devices, default=str))

if __name__ == "__main__":
    main()
