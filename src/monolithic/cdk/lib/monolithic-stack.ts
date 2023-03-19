import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_tg from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets'
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from "aws-cdk-lib/aws-rds";
import { Construct } from 'constructs';

export class MonolithicStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // vpc
    const vpc = new ec2.Vpc(this, 'vpc', {
      vpcName: "sbs-dev-vpc",
      ipAddresses: ec2.IpAddresses.cidr('172.16.0.0/16'),
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
    });

    //
    // Security Groups
    //
    const albSg = new ec2.SecurityGroup(this, "alb-sg", {
      vpc,
      allowAllOutbound: true,
      description: "security group for alb"
    })
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "allow http traffic from anyone")

    const webServerSg = new ec2.SecurityGroup(this, "web-server-sg", {
      vpc,
      allowAllOutbound: true,
      description: "security group for a web server"
    })
    webServerSg.connections.allowFrom(albSg, ec2.Port.tcp(80), 'allow http traffic from alb')

    //
    // web server
    //
    const webServerRole = new iam.Role(this, 'web-server-role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"    // for managed by SSM
        ),
      ],
      description: 'role for web server ec2',
    });

    const userData = ec2.UserData.forLinux({
      shebang: "#!/bin/bash",
    })
    userData.addCommands(
      // setup httpd
      "sudo yum update -y",
      "sudo yum install -y httpd",
      "sudo systemctl start httpd",
      "sudo systemctl enable httpd",
      "sudo sh -c 'echo test > /var/www/html/index.html'",

      // setup Asp.Net Core runtime
      "sudo rpm -Uvh https://packages.microsoft.com/config/centos/7/packages-microsoft-prod.rpm",
      "sudo yum install aspnetcore-runtime-7.0 -y"
    )

    const webServer = new ec2.Instance(this, "ec2-web", {
      instanceName: "sbs-dev-ec2-web",
      instanceType: new ec2.InstanceType("t2.medium"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc: vpc,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      }),
      securityGroup: webServerSg,
      role: webServerRole,
      userData
    });

    //
    // ALB
    //
    const alb = new elbv2.ApplicationLoadBalancer(this, "alb", {
      internetFacing: true,
      vpc,
      vpcSubnets: {
        subnets: vpc.publicSubnets
      },
      securityGroup: albSg
    })

    const instanceTarget = new elbv2_tg.InstanceTarget(webServer)

    const albListener = alb.addListener("AlbHttpListener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP
    })
    albListener.addTargets("WebServerTarget", {
      targets: [instanceTarget],
      port: 80
    })

    //
    // RDS
    //
    const engine = rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0_31 });
    const parameterGroup = new rds.ParameterGroup(this, "BookStoreParamGrp", {
      engine,
      description: "for BookStoreDB"
    })
    const subnetGroup = new rds.SubnetGroup(this, 'BookStoreSubnetGrp', {
      description: "for BookStoreDB",
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });
    const optionGroup = new rds.OptionGroup(this, 'BookStoreOptGrp', {
      engine,
      configurations: [],
      description: "for BookStoreDB"
    })

    new rds.DatabaseInstance(this, "BookStoreDB", {
      engine: engine,
      vpc: vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      databaseName: "bookstore",
      subnetGroup,
      parameterGroup,
      optionGroup
    }).connections.allowDefaultPortFrom(webServerSg);
  }
}
